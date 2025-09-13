Pump.fun 新币狙击脚本完整介绍
📋 项目概述
这是一个基于 TypeScript 开发的 Pump.fun 新币狙击脚本，通过高性能grpc推流获新币信息，获取发币时间，并通过对比发币时间和当前时间差值，以最早时间买入，可以实现与开发者同秒买入，时间差设置的够低甚至可以跟开发者同slot买入
🎯 核心功能
1. 实时新币监控
数据源: SolanaStreaming WebSocket API
监控范围: Pump.fun 平台新发布的代币
响应时间: 检测到新币后立即分析时间差
2. 智能时间过滤
时间阈值: 900ms（可配置）
过滤逻辑: 只处理发布时间差 ≤ 900ms 的新币
目的: 确保确保和开发者同时买入
3. 自动化交易策略
检测新币 → 立即买入 → 延时500ms → 卖出70% → 延时1500ms → 卖出100%
4. 交易确认机制
买入确认: 通过 QuickNode RPC 查询交易状态
卖出确认: 无限重试直到成功,确保不会有持仓
失败处理: 自动重试和错误记录
🏗️ 技术架构
核心技术栈
1. Logger 日志系统
class Logger {
  info()    // 信息日志
  success() // 成功日志
  error()   // 错误日志
  warning() // 警告日志
  debug()   // 调试日志
}
2. 状态管理
全局锁: isProcessing 确保串行执行
防重复: seenMints Set 避免重复处理
性能统计: tradeTimings Map 记录交易耗时
3. WebSocket 连接管理
自动重连: 指数退避算法
心跳检测: 20秒 ping，30秒健康检查
优雅关闭: 进程退出信号处理
⚙️ 配置参数
环境变量配置
# 钱包配置
PUBLIC_KEY=你的钱包公钥
PRIVATE_KEY=你的钱包私钥

# 交易参数
BUY_SOL=0.5                    # 买入金额 (SOL)
BUY_SLIPPAGE=1000              # 买入滑点 (%)
SELL1_SLIPPAGE=1000           # 卖出70%滑点 (%)
SELL2_SLIPPAGE=1000           # 卖出100%滑点 (%)
PRIORITY_FEE=0.00000000005    # 优先费 (SOL)
POOL=pump                      # 交易池

# 时间配置
EVENT_TIMEOUT_MS=900          # 时间阈值 (ms)
FIRST_SELL_DELAY_MS=500       # 卖出70%延迟 (ms)
SECOND_SELL_DELAY_MS=1500     # 卖出100%延迟 (ms)
#接口配置
#SolanaStreaming WebSocket配置 去https://solanastreaming.com/  申请
SOLANA_STREAMING_API_KEY=
支持的交易池
pump - Pump.fun 主池
raydium - Raydium DEX
pump-amm - Pump AMM
launchlab - LaunchLab
raydium-cpmm - Raydium CPMM
bonk - Bonk 池
auto - 自动选择
🔄 工作流程
1. 启动阶段
加载配置 → 创建连接 → 启动WebSocket → 订阅新币事件
2. 监控阶段
接收WebSocket消息 → 解析新币信息 → 计算时间差 → 判断是否处理
3. 交易阶段
买入 → 确认 → 延时500ms → 卖出70% → 延时1500ms → 卖出100% → 确认
4. 错误处理
交易失败 → 自动重试 → 继续监控
📊 性能监控
耗时统计
买入耗时: 从买入开始到卖出70%开始的时间
卖出70%耗时: 卖出70%操作的执行时间
卖出100%耗时: 卖出100%操作的执行时间
总耗时: 整个交易流程的完成时间
日志记录
控制台输出: 实时显示交易状态
文件日志: ./logs/sniper_YYYY-MM-DD.log
统计文件: ./logs/stats_YYYY-MM-DD.json
🛡️ 安全特性
1. 防重复处理
使用 Set 记录已处理的 mint 地址
避免同一代币被重复交易
2. 串行执行
全局处理锁确保同时只处理一个代币
避免并发交易导致的问题
3. 错误恢复
自动重连机制
交易失败自动重试
优雅的错误处理
�� 交易策略详解
买入策略
时机: 检测到新币且时间差 ≤ 900ms（在.env中设置）
金额: 固定 SOL 数量（默认 0.5 SOL）
滑点: 低滑点，确保最优价格
确认: 等待交易确认后再进行下一步
卖出策略
分批卖出: 70% + 100% 两阶段
时间控制: 500ms 和 1500ms 延时
重试机制: 无限重试直到成功
滑点控制: 低滑点卖出70%锁住利润，高滑点卖100%确保不被套
🔧 部署和使用
1. 环境准备
配置.env文件
2. 运行脚本

# 1.先安装nodejs，去https://nodejs.org/ 下载安装
# 2.直接运行
npx ts-node pump-sniper.ts或者双击run.bat
3. 监控日志
# 查看实时运行日志
tail -f logs/sniper_2024-01-01.log

# 查看新pump币统计信息
cat logs/stats_2024-01-01.json
