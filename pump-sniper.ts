/**
 * 优化版 Pump.fun 新币狙击脚本 - 使用本地交易API
 * 功能：
 * 1. 检测新币发布，对比买入时和接收到新币消息的时间，超过1000ms放弃买入
 * 2. 不超过1000ms则立刻买入
 * 3. 买入后500ms卖70%，1500ms卖100%
 * 4. 通过Helius RPC查询卖出是否成功，不成功则重复卖出直到成功
 * 5. 整个流程串行执行，不能多个币同时处理
 */

import 'dotenv/config';
import WebSocket from 'ws';
import { performance } from 'perf_hooks';
import { Connection, VersionedTransaction, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import * as fs from 'fs';
import * as path from 'path';

// ---------- 配置 ----------
const PUBLIC_KEY = process.env.PUBLIC_KEY || '';
const PRIVATE_KEY = process.env.PRIVATE_KEY || '';
if (!PUBLIC_KEY) throw new Error('缺少环境变量 PUBLIC_KEY');
if (!PRIVATE_KEY) throw new Error('缺少环境变量 PRIVATE_KEY');

const BUY_SOL = Number(process.env.BUY_SOL || '0.5');
const BUY_SLIPPAGE = Number(process.env.BUY_SLIPPAGE || '1000');
const SELL1_SLIPPAGE = Number(process.env.SELL1_SLIPPAGE || '1000');
const SELL2_SLIPPAGE = Number(process.env.SELL2_SLIPPAGE || '1000');
const PRIORITY_FEE = Number(process.env.PRIORITY_FEE || '0.00000000005');
const POOL = (process.env.POOL || 'pump') as
  | 'pump'
  | 'raydium'
  | 'pump-amm'
  | 'launchlab'
  | 'raydium-cpmm'
  | 'bonk'
  | 'auto';

const FIRST_SELL_DELAY_MS = Number(process.env.FIRST_SELL_DELAY_MS || '500');
const SECOND_SELL_DELAY_MS = Number(process.env.SECOND_SELL_DELAY_MS || '1500');

// SolanaStreaming WebSocket配置
const SOLANA_STREAMING_API_KEY = process.env.SOLANA_STREAMING_API_KEY || '';
const WS_URL = 'wss://api.solanastreaming.com/';
const TRADE_LOCAL_URL = 'https://pumpportal.fun/api/trade-local';

// QuickNode RPC配置
const QUICKNODE_RPC_URL = 'https://intensive-cool-sailboat.solana-mainnet.quiknode.pro/f6e1b2a4790588351db71721e9b9dcf28ddc7de9';

const EVENT_TIMEOUT_MS = Number(process.env.EVENT_TIMEOUT_MS || '900'); // 1000ms阈值

// 创建连接和密钥对
const web3Connection = new Connection(QUICKNODE_RPC_URL, 'confirmed');
const signerKeyPair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));

// ---------- 日志配置 ----------
const LOG_DIR = './logs';
const LOG_FILE = path.join(LOG_DIR, `sniper_${new Date().toISOString().split('T')[0]}.log`);

// 确保日志目录存在
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// 日志记录器
class Logger {
  private logFile: string;
  
  constructor(logFile: string) {
    this.logFile = logFile;
  }
  
  private writeToFile(level: string, message: string) {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] [${level}] ${message}\n`;
    
    try {
      fs.appendFileSync(this.logFile, logEntry);
    } catch (error) {
      console.error('写入日志文件失败:', error);
    }
  }
  
  info(message: string) {
    console.log(message);
    this.writeToFile('INFO', message);
  }
  
  success(message: string) {
    console.log(`✅ ${message}`);
    this.writeToFile('SUCCESS', message);
  }
  
  error(message: string, error?: any) {
    const errorMsg = error ? `${message}: ${error?.message || error}` : message;
    console.error(`❌ ${errorMsg}`);
    this.writeToFile('ERROR', errorMsg);
  }
  
  warning(message: string) {
    console.warn(`⚠️ ${message}`);
    this.writeToFile('WARNING', message);
  }
  
  debug(message: string) {
    console.log(`🔍 ${message}`);
    this.writeToFile('DEBUG', message);
  }
}

const logger = new Logger(LOG_FILE);

// ---------- 状态管理 ----------
let isProcessing = false; // 全局处理锁，确保同一时间只处理一个币
const seenMints = new Set<string>(); // 防重复处理

// 延时统计
interface TradeTiming {
  mint: string;
  startTime: number;
  buyTime?: number;
  sell70Time?: number;
  sell100Time?: number;
  completeTime?: number;
  totalDuration?: number;
}

const tradeTimings = new Map<string, TradeTiming>();

// ---------- 工具函数 ----------

// 检查交易是否成功（通过QuickNode RPC查询）- 支持无限查询和有限查询
async function checkTransactionSuccess(signature: string, maxAttempts?: number): Promise<boolean> {
  let attempts = 0;
  
  // 无限重试直到有明确结果
  while (maxAttempts === undefined || attempts < maxAttempts) {
    attempts++;
    try {
      const tx = await web3Connection.getTransaction(signature, {
        maxSupportedTransactionVersion: 0
      });
      
      if (tx) {
        if (tx.meta && tx.meta.err === null) {
          logger.success(`交易 ${signature} 成功确认 (第${attempts}次查询)`);
          logger.info(`  - Status: SUCCESS (meta.err = null)`);
          return true;
        } else {
          logger.error(`交易 ${signature} 失败 (第${attempts}次查询)`);
          logger.error(`  - Status: FAILED (meta.err = ${JSON.stringify(tx.meta?.err)})`);
          logger.error(`交易失败，跳过这个币`);
          return false; // 交易失败，跳过这个币
        }
      } else {
        logger.warning(`交易 ${signature} 未找到 (第${attempts}次查询)（节点可能没有保存这么久的历史记录）`);
        
        if (maxAttempts === undefined || attempts < maxAttempts) {
          logger.info(`延时200ms后重新检测交易状态...`);
          await new Promise(resolve => setTimeout(resolve, 200));
          continue;
        } else {
          logger.warning(`已查询${maxAttempts}次，交易仍未找到，视为查询失败`);
          return false;
        }
      }
      
    } catch (error) {
      logger.error(`查询交易 ${signature} 状态失败 (第${attempts}次查询):`, error);
      
      if (maxAttempts === undefined || attempts < maxAttempts) {
        logger.info(`延时200ms后重新检测交易状态...`);
        await new Promise(resolve => setTimeout(resolve, 200));
        continue;
      } else {
        logger.warning(`已查询${maxAttempts}次，查询异常，视为查询失败`);
        return false;
      }
    }
  }
  
  return false;
}



// 发起本地交易
async function tradeLocal(params: {
  action: 'buy' | 'sell';
  mint: string;
  amount: number | string;
  denominatedInSol: boolean;
  slippage: number;
  priorityFee: number;
  pool: typeof POOL;
}): Promise<string> {
  const body = {
    publicKey: PUBLIC_KEY,
    action: params.action,
    mint: params.mint,
    amount: params.amount,
    denominatedInSol: params.denominatedInSol ? 'true' : 'false',
    slippage: params.slippage,
    priorityFee: params.priorityFee,
    pool: params.pool,
  };

  try {
    logger.info(`正在获取${params.action.toUpperCase()}交易数据: ${params.mint}`);
    
    const res = await fetch(TRADE_LOCAL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (res.status === 200) {
      // 成功生成交易
      const data = await res.arrayBuffer();
      const tx = VersionedTransaction.deserialize(new Uint8Array(data));
      
      // 签名交易
      tx.sign([signerKeyPair]);
      
      // 发送交易
      const signature = await web3Connection.sendTransaction(tx);
      
      logger.success(`${params.action.toUpperCase()} ${params.mint} 交易已发送: ${signature}`);
      logger.info(`交易链接: https://solscan.io/tx/${signature}`);
      
      return signature;
    } else {
      const errorText = await res.text();
      throw new Error(`获取交易数据失败: HTTP ${res.status} -> ${errorText}`);
    }
    
  } catch (error: any) {
    logger.error(`${params.action.toUpperCase()} 错误: ${error?.message || error}`);
    throw error;
  }
}

// 买入操作
async function executeBuy(mint: string): Promise<string | null> {
  try {
    const signature = await tradeLocal({
      action: 'buy',
      mint,
      amount: BUY_SOL,
      denominatedInSol: true,
      slippage: BUY_SLIPPAGE,
      priorityFee: PRIORITY_FEE,
      pool: POOL,
    });
    
    // 延时200ms后再查询买入是否成功
    logger.info(`延时200ms后查询买入交易状态: ${signature}`);
    await new Promise(resolve => setTimeout(resolve, 200));
    
    // 通过QuickNode RPC查询买入是否成功
    logger.info(`正在查询买入交易状态: ${signature}`);
    const isSuccess = await checkTransactionSuccess(signature);
    
    if (isSuccess) {
      logger.success(`买入成功确认: ${mint} -> ${signature}`);
      return signature;
    } else {
      logger.error(`买入失败: ${mint} - 交易未成功确认`);
      return null;
    }
  } catch (error) {
    logger.error(`买入执行失败: ${mint}`, error);
    return null;
  }
}

// 卖出70% - 延时500ms后执行，只需要判断接口返回signature
async function executeSell70(mint: string, buySignature: string): Promise<string> {
  try {
    // 延时500ms后执行卖出70%
    logger.info(`延时500ms后执行卖出70%: ${mint}`);
    await new Promise(resolve => setTimeout(resolve, FIRST_SELL_DELAY_MS));
    
    // 无限重试卖出70%，直到获得signature
    while (true) {
      try {
        const signature = await tradeLocal({
          action: 'sell',
          mint,
          amount: '70%',
          denominatedInSol: false,
          slippage: SELL1_SLIPPAGE,
          priorityFee: 0, // 卖1优先费设为0
          pool: POOL,
        });
        
        logger.success(`卖出70%成功: ${mint} -> ${signature}`);
        return signature;
      } catch (error) {
        logger.error(`卖出70%执行失败，等待后重试: ${mint}`, error);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  } catch (error) {
    logger.error(`卖出70%严重错误: ${mint}`, error);
    // 即使有错误也要继续重试
    throw error;
  }
}

// 卖出100% - 延时1500ms后执行，查询3次失败后重复执行一次卖100%，然后记录失败信息
async function executeSell100(mint: string, sell70Signature: string): Promise<string> {
  try {
    // 延时1500ms后执行卖出100%
    logger.info(`延时1500ms后执行卖出100%: ${mint}`);
    await new Promise(resolve => setTimeout(resolve, SECOND_SELL_DELAY_MS));
    
    // 无限重试卖出100%，直到通过QuickNode RPC确认成功
    while (true) {
      try {
        const signature = await tradeLocal({
          action: 'sell',
          mint,
          amount: '100%',
          denominatedInSol: false,
          slippage: SELL2_SLIPPAGE,
          priorityFee: 0, // 卖2优先费设为0
          pool: POOL,
        });
        
        logger.success(`卖出100%接口成功: ${mint} -> ${signature}`);
        
        // 延时700ms后再查询卖出是否成功
        logger.info(`延时700ms后查询卖出100%交易状态: ${signature}`);
        await new Promise(resolve => setTimeout(resolve, 700));
        
        // 通过QuickNode RPC查询卖出是否成功（最多查询3次）
        logger.info(`正在查询卖出100%交易状态: ${signature}`);
        const isSuccess = await checkTransactionSuccess(signature, 3);
        
        if (isSuccess) {
          logger.success(`卖出100%成功确认: ${mint} -> ${signature}`);
          return signature; // 交易成功，进入下一阶段
        } else {
          // 查询3次失败，重复执行一次卖100%
          logger.error(`卖出100%查询失败 (3次查询)，重复执行一次卖100%...`);
          
          try {
            // 重复执行一次卖100%
            const retrySignature = await tradeLocal({
              action: 'sell',
              mint,
              amount: '100%',
              denominatedInSol: false,
              slippage: SELL2_SLIPPAGE,
              priorityFee: 0,
              pool: POOL,
            });
            
            logger.success(`重复卖出100%接口成功: ${mint} -> ${retrySignature}`);
            
           
            
            // 返回最后一次的签名，进入下一阶段
            logger.info(`已记录失败信息，进入下一阶段: ${mint}`);
            return retrySignature;
          } catch (retryError) {
            logger.error(`重复卖出100%执行失败: ${mint}`, retryError);
            
         
            
            // 返回原始签名，进入下一阶段
            logger.info(`已记录失败信息，进入下一阶段: ${mint}`);
            return signature;
          }
        }
      } catch (error) {
        logger.error(`卖出100%执行失败，等待后重试: ${mint}`, error);
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    }
  } catch (error) {
    logger.error(`卖出100%严重错误: ${mint}`, error);
    // 即使有错误也要继续重试
    throw error;
  }
}

// 完整的买卖流程
async function executeBuySellFlow(mint: string): Promise<void> {
  // 记录开始时间
  const startTime = performance.now();
  const timing: TradeTiming = {
    mint,
    startTime
  };
  tradeTimings.set(mint, timing);
  
  try {
    logger.info(`开始处理新币: ${mint}`);
    
    // 1. 买入
    const buyStartTime = performance.now();
    const buyResult = await executeBuy(mint);
    
    if (!buyResult) {
      logger.error(`买入失败，跳过后续操作: ${mint}`);
      return;
    }
    
    // 2. 延时500ms后执行卖出70%
    const sell70StartTime = performance.now();
    const sell70Signature = await executeSell70(mint, buyResult);
    const sell70EndTime = performance.now();
    
    // 买入耗时 = 从买入开始到卖出70%开始的时间
    timing.buyTime = sell70StartTime - buyStartTime;
    logger.info(`买入耗时: ${timing.buyTime.toFixed(2)}ms`);
    
    timing.sell70Time = sell70EndTime - sell70StartTime;
    logger.info(`卖出70%耗时: ${timing.sell70Time.toFixed(2)}ms`);
    
    // 3. 延时1500ms后执行卖出100%
    const sell100StartTime = performance.now();
    const sell100Signature = await executeSell100(mint, sell70Signature);
    const sell100EndTime = performance.now();
    
    timing.sell100Time = sell100EndTime - sell100StartTime;
    logger.info(`卖出100%耗时: ${timing.sell100Time.toFixed(2)}ms`);
    
    // 4. 计算总耗时并完成流程
    const totalDuration = performance.now() - startTime;
    timing.completeTime = performance.now();
    timing.totalDuration = totalDuration;
    
    logger.success(`新币 ${mint} 处理完成！总耗时: ${totalDuration.toFixed(2)}ms`);
    logger.info(`详细耗时统计:`);
    logger.info(`  - 买入: ${timing.buyTime?.toFixed(2)}ms`);
    logger.info(`  - 卖出70%: ${timing.sell70Time?.toFixed(2)}ms`);
    logger.info(`  - 卖出100%: ${timing.sell100Time?.toFixed(2)}ms`);
    logger.info(`所有交易完成，可以继续检测新币`);
    
  } catch (error) {
    logger.error(`处理新币 ${mint} 时发生错误:`, error);
  } finally {
    // 释放处理锁
    isProcessing = false;
    logger.info(`释放处理锁，可以处理下一个新币`);
  }
}

// ---------- SolanaStreaming WebSocket 事件处理 ----------
function start() {
  let ws: WebSocket | null = null;
  let reconnectAttempts = 0;
  const maxReconnectAttempts = 10;
  let reconnectTimeout: NodeJS.Timeout | null = null;
  let heartbeatInterval: NodeJS.Timeout | null = null;
  let lastHeartbeat = Date.now();
  
  const connect = () => {
    try {
      ws = new WebSocket(WS_URL, undefined, {
        headers: {
          "X-API-KEY": SOLANA_STREAMING_API_KEY,
        },
      });

      ws.on('open', () => {
        logger.info('SolanaStreaming WebSocket 已连接');
        reconnectAttempts = 0; // 重置重连次数
        
        // 发送订阅消息
        const subscribeMsg = {
          jsonrpc: "2.0",
          id: 1,
          method: "newPairSubscribe",
          params: {
            include_pumpfun: true
          }
        };
        
        ws!.send(JSON.stringify(subscribeMsg));
        logger.info('SolanaStreaming 订阅已启动 - 监控新代币创建...');
        
        // 启动心跳检测
        startHeartbeat();
      });

      ws.on('message', (raw) => {
        try {
          // 更新最后心跳时间
          lastHeartbeat = Date.now();
          
          // 如果正在处理其他币，忽略新事件
          if (isProcessing) {
            return;
          }
          
          const msg = JSON.parse(raw.toString());
          
          if (msg?.method === 'newPairNotification' && msg?.params?.pair?.baseToken?.account) {
            const mint = msg.params.pair.baseToken.account.trim();
            const blockTime = msg.params.blockTime * 1000; // 转换为毫秒
            const currentTime = Date.now();
            const timeDiff = currentTime - blockTime;
            
            // 防重复处理
            if (seenMints.has(mint)) {
              return;
            }
            
            logger.info(`检测到新币: ${mint}`);
            logger.info(`代币信息:`);
            logger.info(`  - 名称: ${msg.params.pair.baseToken.info?.metadata?.name || 'N/A'}`);
            logger.info(`  - 符号: ${msg.params.pair.baseToken.info?.metadata?.symbol || 'N/A'}`);
            logger.info(`  - Mint地址: ${mint}`);
            logger.info(`  - 交易签名: ${msg.params.signature}`);
            logger.info(`  - Slot: ${msg.params.slot}`);
            logger.info(`  - AMM账户: ${msg.params.pair.ammAccount}`);
            logger.info(`  - 代币发布时间: ${new Date(blockTime).toISOString()}`);
            logger.info(`  - 当前时间: ${new Date().toISOString()}`);
            logger.info(`  - 时间差: ${timeDiff}ms`);
            
            // 检查时间差是否在900ms内
            if (timeDiff <= EVENT_TIMEOUT_MS) {
              logger.info(`时间差符合要求 (${timeDiff}ms <= ${EVENT_TIMEOUT_MS}ms)`);
              
              // 标记为已处理
              seenMints.add(mint);
              isProcessing = true;
              
              // 异步执行买卖流程，不阻塞WebSocket
              executeBuySellFlow(mint).catch(error => {
                logger.error(`执行买卖流程时发生错误: ${error}`);
                isProcessing = false;
              });
            } else {
              logger.warning(`新币 ${mint} 时间差过大 (${timeDiff}ms > ${EVENT_TIMEOUT_MS}ms)，跳过处理`);
            }
          }
        } catch (error) {
          logger.error(`解析SolanaStreaming WebSocket消息时出错: ${error}`);
        }
      });

      ws.on('error', (error) => {
        logger.error(`SolanaStreaming WebSocket 错误: ${error}`);
      });
      
      ws.on('close', (code, reason) => {
        logger.warning(`SolanaStreaming WebSocket 连接关闭: ${code} ${reason.toString()}`);
        
        // 清理心跳检测
        stopHeartbeat();
        
        // 重连逻辑
        if (reconnectAttempts < maxReconnectAttempts) {
          reconnectAttempts++;
          const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000); // 指数退避，最大30秒
          
          logger.info(`准备重连 (第${reconnectAttempts}次)，${delay}ms后重连...`);
          
          reconnectTimeout = setTimeout(() => {
            logger.info(`开始重连 SolanaStreaming WebSocket...`);
            connect();
          }, delay);
        } else {
          logger.error(`重连次数已达上限 (${maxReconnectAttempts}次)，停止重连`);
        }
      });

      ws.on('pong', () => {
        logger.debug('收到 WebSocket pong 响应');
        lastHeartbeat = Date.now();
      });

    } catch (error) {
      logger.error(`创建 WebSocket 连接时出错: ${error}`);
      
      // 重连逻辑
      if (reconnectAttempts < maxReconnectAttempts) {
        reconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
        
        logger.info(`准备重连 (第${reconnectAttempts}次)，${delay}ms后重连...`);
        
        reconnectTimeout = setTimeout(() => {
          logger.info(`开始重连 SolanaStreaming WebSocket...`);
          connect();
        }, delay);
      }
    }
  };
  
  // 启动心跳检测
  const startHeartbeat = () => {
    // 清理之前的心跳检测
    stopHeartbeat();
    
    // 每20秒发送一次ping
    heartbeatInterval = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.ping();
          logger.debug('发送 WebSocket ping');
        } catch (error) {
          logger.error(`发送 ping 失败: ${error}`);
        }
      }
    }, 20000);
    
    // 每30秒检查一次连接状态
    const healthCheckInterval = setInterval(() => {
      const now = Date.now();
      const timeSinceLastHeartbeat = now - lastHeartbeat;
      
      if (timeSinceLastHeartbeat > 60000) { // 60秒没有收到消息
        logger.warning(`WebSocket 连接可能已断开 (${timeSinceLastHeartbeat}ms 未收到消息)`);
        
        if (ws && ws.readyState === WebSocket.OPEN) {
          logger.info('主动关闭 WebSocket 连接以触发重连');
          ws.close();
        }
      }
    }, 30000);
    
    // 保存健康检查定时器以便清理
    (heartbeatInterval as any).healthCheck = healthCheckInterval;
  };
  
  // 停止心跳检测
  const stopHeartbeat = () => {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      if ((heartbeatInterval as any).healthCheck) {
        clearInterval((heartbeatInterval as any).healthCheck);
      }
      heartbeatInterval = null;
    }
  };
  
  // 启动连接
  connect();
  
  // 优雅关闭处理
  const cleanup = () => {
    logger.info('正在关闭 WebSocket 连接...');
    
    // 清理定时器
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
    }
    stopHeartbeat();
    
    // 关闭连接
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
  };
  
  // 监听进程退出信号
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('exit', cleanup);
  
  return cleanup;
}

// ---------- 启动脚本 ----------
logger.info('启动优化版新币狙击脚本 (使用本地交易API)...');
logger.info(`配置信息:`);
logger.info(`   - 钱包公钥: ${PUBLIC_KEY}`);
logger.info(`   - 买入金额: ${BUY_SOL} SOL`);
logger.info(`   - 买入滑点: ${BUY_SLIPPAGE}%`);
logger.info(`   - 卖1滑点: ${SELL1_SLIPPAGE}%`);
logger.info(`   - 卖2滑点: ${SELL2_SLIPPAGE}%`);
logger.info(`   - 买入优先费: ${PRIORITY_FEE} SOL`);
logger.info(`   - 卖1优先费: 0 SOL`);
logger.info(`   - 卖2优先费: 0 SOL`);
logger.info(`   - 交易池: ${POOL}`);
logger.info(`   - 时间阈值: ${EVENT_TIMEOUT_MS}ms`);
logger.info(`   - 卖出70%延迟: ${FIRST_SELL_DELAY_MS}ms`);
logger.info(`   - 卖出100%延迟: ${SECOND_SELL_DELAY_MS}ms`);
logger.info(`   - WebSocket: SolanaStreaming (带心跳检测)`);
logger.info(`   - RPC: QuickNode`);
logger.info(`   - 交易API: PumpPortal Local API`);

// 定期保存统计信息
setInterval(() => {
  if (tradeTimings.size > 0) {
    const statsFile = path.join(LOG_DIR, `stats_${new Date().toISOString().split('T')[0]}.json`);
    try {
      const stats = Array.from(tradeTimings.values());
      fs.writeFileSync(statsFile, JSON.stringify(stats, null, 2));
      logger.debug(`统计信息已保存到: ${statsFile}`);
    } catch (error) {
      logger.error('保存统计信息失败:', error);
    }
  }
}, 60000); // 每分钟保存一次

// 启动 WebSocket 连接
const cleanup = start();