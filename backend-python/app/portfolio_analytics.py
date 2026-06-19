import os
import datetime
import numpy as np
import pandas as pd
import yfinance as yf
from sqlalchemy import text
from db_compat import get_engine
from pydantic import BaseModel
from typing import List, Dict

DB_PATH = os.environ.get('DATABASE_URL', os.path.join(os.getcwd(), 'database.sqlite'))
DATABASE_URL = DB_PATH if DB_PATH.startswith("sqlite:///") else f"sqlite:///{DB_PATH}"

class PortfolioRequest(BaseModel):
    symbols: List[str]
    weights: List[float] # sum should ideally be 1.0

def get_nifty50_data(start_date: str, end_date: str) -> pd.DataFrame:
    # yfinance uses ^NSEI for Nifty 50
    try:
        data = yf.download('^NSEI', start=start_date, end=end_date, progress=False)
        # Handle multiindex columns if any
        if isinstance(data.columns, pd.MultiIndex):
            data = data.xs('Close', axis=1, level=0)
        else:
            data = data[['Close']]
        data.index = data.index.strftime('%Y-%m-%d')
        data.rename(columns={'Close': 'NIFTY', '^NSEI': 'NIFTY'}, inplace=True)
        return data
    except Exception as e:
        print(f"Error fetching NIFTY data: {e}")
        return pd.DataFrame()

def analyze_portfolio(req: PortfolioRequest):
    engine = get_engine()
    symbols = req.symbols
    weights = np.array(req.weights)
    weights = weights / np.sum(weights) # normalize

    # Fetch last 1 year of data
    one_year_ago = (datetime.date.today() - datetime.timedelta(days=365)).isoformat()
    today = datetime.date.today().isoformat()

    price_data = {}
    with engine.connect() as conn:
        for sym in symbols:
            query = text("SELECT date, close FROM stock_ohlcv WHERE symbol = :sym AND date >= :start ORDER BY date ASC")
            df = pd.read_sql(query, conn, params={"sym": sym, "start": one_year_ago})
            if not df.empty:
                df.set_index('date', inplace=True)
                price_data[sym] = df['close']

    if not price_data:
        return {"error": "No historical data found for the given symbols."}

    prices_df = pd.DataFrame(price_data).dropna()
    
    # Calculate daily returns
    returns_df = prices_df.pct_change().dropna()
    
    # Calculate correlation matrix
    corr_matrix = returns_df.corr().to_dict()

    # Fetch Nifty data for the same dates
    start_date = prices_df.index[0]
    nifty_df = get_nifty50_data(start_date, today)

    if not nifty_df.empty:
        # Merge Nifty with our returns
        nifty_returns = nifty_df.pct_change().dropna()
        nifty_returns.index = pd.to_datetime(nifty_returns.index)
        returns_df.index = pd.to_datetime(returns_df.index)
        
        # align indexes
        merged = returns_df.join(nifty_returns, how='inner')
        nifty_col = [c for c in merged.columns if 'NIFTY' in c][0]
        
        market_variance = merged[nifty_col].var()
        
        betas = {}
        for sym in symbols:
            if sym in merged.columns:
                covariance = merged[[sym, nifty_col]].cov().iloc[0, 1]
                beta = covariance / market_variance if market_variance > 0 else 1
                betas[sym] = round(beta, 2)
                
        # Portfolio Beta
        portfolio_beta = sum(betas.get(sym, 1.0) * weights[i] for i, sym in enumerate(symbols))
    else:
        betas = {sym: 1.0 for sym in symbols}
        portfolio_beta = 1.0

    # Portfolio metrics
    # Daily portfolio returns
    port_returns = returns_df.dot(weights)
    
    # Annualized return (assuming 252 trading days)
    annualized_return = port_returns.mean() * 252
    
    # Annualized volatility
    annualized_vol = port_returns.std() * np.sqrt(252)
    
    # Sharpe Ratio (assuming 7% risk free rate in India)
    risk_free_rate = 0.07
    sharpe_ratio = (annualized_return - risk_free_rate) / annualized_vol if annualized_vol > 0 else 0

    # Value at Risk (95% confidence, historical)
    var_95 = np.percentile(port_returns, 5)

    return {
        "annualized_return": round(annualized_return, 4),
        "annualized_volatility": round(annualized_vol, 4),
        "sharpe_ratio": round(sharpe_ratio, 2),
        "beta": round(portfolio_beta, 2),
        "var_95": round(var_95, 4),
        "correlation_matrix": corr_matrix,
        "individual_betas": betas
    }
