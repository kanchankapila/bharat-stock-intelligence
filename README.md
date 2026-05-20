# 🚀 AlphaQuant Pro: Institutional-Grade Stock Intelligence

AlphaQuant Pro is a powerful, local-first quantitative stock ranking and intelligence platform. It synthesizes technical, fundamental, and sentiment signals to provide high-conviction trading signals and multi-horizon consensus rankings.

## 🌟 Key Features

### 1. 🧬 Multi-Factor Consensus Engine
- **Cross-Screener Intelligence**: Ingests and normalizes data from **Trendlyne**, **Moneycontrol**, and **ETnow**.
- **Domain Attribution**: Automatically identifies the primary driver of a stock's performance (Fundamental, Technical, Momentum, or Delivery).
- **Dual-Horizon Ranking**: Separate leaderboards for **Long-Term Institutional Investing** and **Intraday Momentum Trading**.

### 2. 📰 Real-Time Sentiment Analysis
- **News Ingestion**: Automated tracking of major market news and corporate announcements.
- **Sentiment Scoring**: NLP-driven classification (Positive/Negative/Neutral) with high-impact weightage (1.2x) in the final score.

### 3. 📊 Quantitative Technical Engine
- **Automated Backfilling**: Scripted OHLCV data retrieval using `yfinance` for deep historical context.
- **Indicator Suite**: Real-time calculation of **RSI**, **MACD**, **EMA Crossovers**, and **Bollinger Bands**.
- **Pattern Recognition**: AI-powered detection of candlestick patterns (Bullish Engulfing, Doji, Hammer, etc.).
- **Predictive Signaling**: Automated **Entry**, **Target**, and **Stop-Loss** price predictions with institutional risk/reward ratios.

### 4. 🤖 Local-First AI Architecture
- **Ollama Integration**: Runs heavy LLM analysis (Mistral/Llama3) locally to ensure data privacy and zero API costs.
- **BullMQ Pipeline**: Scalable background job system for parallel stock analysis and data refreshes.
- **Stability Optimized**: Fine-tuned worker concurrency and lock durations for robust performance on local hardware.

---

## 🛠️ Setup & Installation

### Prerequisites
- **Node.js** (v18+)
- **Python** (3.10+)
- **Redis Server** (Local or Remote)
- **Ollama** (Optional, for AI features)

### 1. Environment Configuration
Create a `.env` file in the root directory and configure the following variables:

```env
# AI & Intelligence
GEMINI_API_KEY=your_gemini_key_here
OLLAMA_MODEL=mistral                  # Model name in Ollama

# Infrastructure
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=                       # Optional

# Database
DATABASE_URL=sqlite:///database.sqlite
```

### 2. Install Dependencies
```bash
# Install Node.js dependencies
npm install

# Install Python analytical libraries
pip install -r requirements.txt
```

### 3. Initialize Database
```bash
npx tsx scratch/init_db.js
```

---

## 🚀 Execution Workflow

### 1. Start the Core Services
Ensure Redis is running, then start the application:
```bash
# Terminal 1: Start Redis (if local)
.\redis-server.exe

# Terminal 2: Start the Web App & tRPC Server
npm run dev
```

### 2. Run the Intelligence Pipeline
Execute these scripts periodically to update the quantitative engine:

```bash
# Step A: Backfill historical OHLCV data (Top 200 stocks)
python src/server/backfill_ohlcv.py

# Step B: Generate Technical Signals & Price Predictions
python src/server/technical_analysis_engine.py

# Step C: Run Multi-Factor Consensus Scoring (Consolidates all signals)
python src/server/scoring_engine.py
```

### 3. Seed Initial Intelligence (Optional)
```bash
node src/server/seed_news.cjs
```

---

## 🏗️ Architecture Stack
- **Frontend**: React 18, Tailwind CSS, Motion (Framer Motion)
- **Backend**: tRPC (Type-safe API), Node.js (Vite Runtime)
- **Background Jobs**: BullMQ + Redis
- **Analytics**: Python (Pandas, yfinance, ta-lib alternative)
- **Database**: SQLite (Local Persistence)

---
*Built with ❤️ for High-Conviction Traders.*
