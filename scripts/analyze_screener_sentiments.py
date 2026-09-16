import os
import sys

sys.path.insert(0, os.path.join(os.getcwd(), 'src', 'server'))
from db_compat import connect

def classify_screener(name: str) -> str:
    nl = name.lower()

    # Special Value / Reversal / Turnaround Overrides
    if 'turnaround' in nl and 'loss to profit' in nl:
        return 'bullish'
    if 'good fundamental' in nl and 'near 52 week low' in nl:
        return 'bullish'
    if any(k in nl for k in [
        'pe less than industry', 'pe less than sector', 'peg lower than industry',
        'peg lower than sector', 'price to book value (p/bv) less than'
    ]):
        return 'bullish'

    # Bearish / Sell indicators
    if any(k in nl for k in [
        'trending down', 'crossed below', 'crossed -80 from above', 'overbought',
        'bearish', 'breakdown', 'death cross', 'lower low', 'volume loser',
        'downgrade', 'profit fall', 'loss', 'new 52 week low', 'underperform',
        'promoter pledge', 'high debt', 'less than industry', 'lower than sector',
        'less than sector', 'lower than industry', 'falling rsi', 'macd negative',
        'signal changed to sell', 'negative surprise', 'negative revenue growth',
        'negative quarterly', 'negative eps', 'analysts estimate negative', 'profit to loss'
    ]):
        return 'bearish'

    # Bullish / Buy indicators
    if any(k in nl for k in [
        'trending up', 'crossed above', 'oversold', 'bullish', 'breakout',
        'golden cross', 'higher high', 'volume gainer', 'signal changed to buy',
        'new 52 week high', 'high delivery', 'volume spike', 'fii buying', 'dii buying',
        'profit growth', 'revenue growth', 'earnings beat', 'upgrade', 'outperform',
        'strong buy', 'high momentum', 'multibagger', 'piotroski score', 'high roe',
        'positive surprise', 'positive revenue growth', 'positive quarterly', 'positive eps',
        'analysts estimate positive'
    ]):
        return 'bullish'

    return 'neutral'

def main():
    conn = connect()
    rows = conn.execute('''
        SELECT DISTINCT screener_name 
        FROM screener_catalog 
        WHERE LOWER(signal_bias) = 'neutral' 
        ORDER BY screener_name
    ''').fetchall()

    bulls = [r[0] for r in rows if classify_screener(r[0]) == 'bullish']
    bears = [r[0] for r in rows if classify_screener(r[0]) == 'bearish']
    neuts = [r[0] for r in rows if classify_screener(r[0]) == 'neutral']

    report = []
    report.append(f"TOTAL NEUTRAL SCREENERS EVALUATED: {len(rows)}")
    report.append(f"  - Proposed BULLISH (BUY) : {len(bulls)}")
    report.append(f"  - Proposed BEARISH (SELL): {len(bears)}")
    report.append(f"  - Remain TRULY NEUTRAL   : {len(neuts)}")

    print("\n".join(report[:4]))

    with open('screener_proposal.txt', 'w', encoding='utf-8') as f:
        f.write("\n".join(report) + "\n\n")
        f.write("=== PROPOSED RECLASSIFICATION DETAILS ===\n\n")
        
        f.write("--- 1. PROPOSED BULLISH / BUY SCREENERS ---\n")
        for b in bulls:
            f.write(f"  [BUY] {b}\n")
            
        f.write("\n--- 2. PROPOSED BEARISH / SELL SCREENERS ---\n")
        for b in bears:
            f.write(f"  [SELL] {b}\n")
            
        f.write("\n--- 3. REMAINING TRULY NEUTRAL / THEME SCREENERS (Sample) ---\n")
        for n in neuts[:50]:
            f.write(f"  [NEUTRAL] {n}\n")

if __name__ == '__main__':
    main()

