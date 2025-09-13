# Pump.fun New Token Sniper Script – Full Documentation

📋 **Project Overview**  
This is a Pump.fun new token sniper script developed in TypeScript.  
It retrieves new token information via high-performance gRPC streaming, obtains token launch times, and compares them with the current system time.  
By executing buy orders at the earliest possible moment, it allows you to buy simultaneously with the developer.  
With sufficiently low time thresholds, it can even achieve the same slot purchase as the developer.  

---

🎯 **Core Features**  

1. **Real-time Token Monitoring**  
   - Data source: SolanaStreaming WebSocket API  
   - Monitoring scope: Newly launched tokens on Pump.fun  
   - Response time: Immediate analysis after detecting a new token  

2. **Smart Time Filtering**  
   - Time threshold: 900ms (configurable)  
   - Filtering logic: Only process tokens with a launch time difference ≤ 900ms  
   - Goal: Ensure buying at the same time as the developer  

3. **Automated Trading Strategy**  
   - Detect new token → Buy immediately → Wait 500ms → Sell 70% → Wait 1500ms → Sell 100%  

4. **Trade Confirmation Mechanism**  
   - Buy confirmation: Verify transaction status via QuickNode RPC  
   - Sell confirmation: Retry infinitely until successful (ensures no leftover position)  
   - Failure handling: Automatic retries and error logging  

---

🏗️ **Technical Architecture**  

**Core Tech Stack**  

1. **Logger System**  
```ts
class Logger {
  info()    // Info logs
  success() // Success logs
  error()   // Error logs
  warning() // Warning logs
  debug()   // Debug logs
}
```

2. **State Management**  
   - Global lock: `isProcessing` ensures serial execution  
   - Duplicate prevention: `seenMints` Set avoids reprocessing  
   - Performance tracking: `tradeTimings` Map records trade durations  

3. **WebSocket Connection Management**  
   - Auto-reconnect: Exponential backoff algorithm  
   - Heartbeat: 20s ping, 30s health check  
   - Graceful shutdown: Signal handling on process exit  

---

⚙️ **Configuration Parameters**  

**Environment Variables**  

```bash
# Wallet Configuration
PUBLIC_KEY=your_wallet_public_key
PRIVATE_KEY=your_wallet_private_key

# Trading Parameters
BUY_SOL=0.5                    # Buy amount (SOL)
BUY_SLIPPAGE=1000              # Buy slippage (%)
SELL1_SLIPPAGE=1000            # Slippage for selling 70%
SELL2_SLIPPAGE=1000            # Slippage for selling 100%
PRIORITY_FEE=0.00000000005     # Priority fee (SOL)
POOL=pump                      # Trading pool

# Time Settings
EVENT_TIMEOUT_MS=900           # Time threshold (ms)
FIRST_SELL_DELAY_MS=500        # Delay before selling 70% (ms)
SECOND_SELL_DELAY_MS=1500      # Delay before selling 100% (ms)

# API Configuration
# Apply for SolanaStreaming WebSocket API Key at https://solanastreaming.com/
SOLANA_STREAMING_API_KEY=
```

**Supported Pools**  
- `pump` - Pump.fun main pool  
- `raydium` - Raydium DEX  
- `pump-amm` - Pump AMM  
- `launchlab` - LaunchLab  
- `raydium-cpmm` - Raydium CPMM  
- `bonk` - Bonk pool  
- `auto` - Auto select  

---

🔄 **Workflow**  

1. **Initialization**  
   Load config → Establish connection → Start WebSocket → Subscribe to new token events  

2. **Monitoring**  
   Receive WebSocket message → Parse token info → Calculate time difference → Decide whether to trade  

3. **Trading**  
   Buy → Confirm → Wait 500ms → Sell 70% → Wait 1500ms → Sell 100% → Confirm  

4. **Error Handling**  
   Trade failure → Auto retry → Continue monitoring  

---

📊 **Performance Monitoring**  

- **Time Statistics**  
  - Buy duration: Time from buy start to first sell  
  - Sell 70% duration: Execution time of selling 70%  
  - Sell 100% duration: Execution time of selling 100%  
  - Total duration: Full trading cycle  

- **Logging**  
  - Console output: Real-time trade status  
  - File logs: `./logs/sniper_YYYY-MM-DD.log`  
  - Stats file: `./logs/stats_YYYY-MM-DD.json`  

---

🛡️ **Security Features**  

1. **Duplicate Prevention**  
   - Use a Set to record processed mint addresses  
   - Avoid re-trading the same token  

2. **Serial Execution**  
   - Global lock ensures one token is processed at a time  
   - Prevents concurrency-related issues  

3. **Error Recovery**  
   - Auto-reconnect mechanism  
   - Automatic retry on trade failure  
   - Graceful error handling  

---

📈 **Trading Strategy Details**  

**Buy Strategy**  
- Condition: Detected token with time difference ≤ 900ms (configurable in `.env`)  
- Amount: Fixed SOL amount (default 0.5 SOL)  
- Slippage: Low slippage for best price  
- Confirmation: Wait until transaction is confirmed before proceeding  

**Sell Strategy**  
- Split selling: 70% + 100% (two phases)  
- Timing: 500ms and 1500ms delays  
- Retry: Infinite retries until success  
- Slippage control:  
  - Low slippage for 70% (to lock in profit)  
  - Higher slippage for 100% (to guarantee exit)  

---

🔧 **Deployment & Usage**  

1. **Setup**  
   - Configure `.env` file  

2. **Run Script**  
```bash
# 1. Install Node.js from https://nodejs.org/  
# 2. Run directly:
npx ts-node pump-sniper.ts
# or double-click run.bat
```

3. **Monitor Logs**  
```bash
# View live logs
tail -f logs/sniper_2024-01-01.log

# View Pump token statistics
cat logs/stats_2024-01-01.json
```
