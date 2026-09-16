"""Pins the screener labels produced by the classification PATH that actually writes them.

Asserts `screener_catalog_enricher.resolve_screener_defaults` (which routes through
`classify_screener` -- the function `scripts/reclassify_screener_sentiments_all.py` uses to
write `screener_catalog.signal_bias` / `screener_master.inferred_sentiment`). Verified
2026-08-29: it returns the expected label for every name below, 0 mismatches.

It deliberately does NOT assert `NLPScreenerInference.domain_override`. That is an OVERRIDE
layer, not the classifier: its documented contract is to answer only for families the
generic layers get wrong and otherwise return None so the caller falls through to FinBERT
plus the generic keyword counts. Asserting a verdict from it for every name forced it to
answer for everything, which broke nine pre-existing tests in
`test_screener_sentiment_domain.py` -- including the MEASURED families, where a 5-year
backtest (oversold -1.25%/mo, t=-4.26, 0 of 6 years positive; overbought t=-0.18, no signal
either way) contradicts the plain-English reading.

KNOWN, UNRESOLVED DISAGREEMENT -- see docs/audit-findings.md AF-20260829-11 / AF-20260829-12.
The two layers give opposite answers on the oversold/overbought families: this path says
`15 min CCI Oversold` is bullish, `domain_override` says bearish on measured evidence.
test_known_layer_disagreement_is_visible below pins that so it cannot drift silently. It is
recorded, not resolved: picking a winner is a scoring change and `.claude/rules/measurement.md`
requires it be measured first.
"""
import unittest
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from nlp_engine import NLPScreenerInference
import screener_catalog_enricher as sce

class TestScreenerDomainClassification(unittest.TestCase):

    def test_bullish_classifications(self):
        bullish_names = [
            "15 min CCI Oversold",
            "15 min ROC Trending Up",
            "15 min Willaims %R in Oversold zone",
            "Annual Profit Growth higher than Industry Profit Growth",
            "Annual revenue and EPS positive surprise",
            "Broker Reco and Target Upgrades in the Past Six Months",
            "Bullish Harami Cross",
            "High Piotroski Score Screener",
            "Turnaround Companies: Loss to Profit QoQ",
            "Good Fundamental Stock Near 52 Week Low",
            "PE less than Industry PE",
            "PEG lower than Sector PEG"
        ]
        for name in bullish_names:
            sce_bias, _, _, _ = sce.resolve_screener_defaults('technical', 'neutral', name)
            self.assertEqual(sce_bias, 'bullish', f"SCE failed for {name}")

    def test_bearish_classifications(self):
        bearish_names = [
            "15 min ROC Trending Down",
            "15 min Williams %R crossed -80 from above",
            "15 min Williams %R in Overbought zone",
            "Annual Profit Growth less than Industry Profit Growth",
            "Annual revenue and EPS negative surprise",
            "Broker downgrades in price or recommendation in the past one month",
            "CCI Trending Down",
            "CCI crossed below -100",
            "Companies with High Debt",
            "Profit to Loss Companies",
            "New 52 week low today"
        ]
        for name in bearish_names:
            sce_bias, _, _, _ = sce.resolve_screener_defaults('technical', 'neutral', name)
            self.assertEqual(sce_bias, 'bearish', f"SCE failed for {name}")

    def test_truly_neutral_classifications(self):
        neutral_names = [
            "15 min ADX Mild Trending Stocks",
            "ADX Trending Stocks",
            "AI stocks in India",
            "Adani Group share prices & companies list",
            "ASM (Additional Surveillance Measure)/GSM (Graded Surveillance Measure) stock list"
        ]
        for name in neutral_names:
            override = NLPScreenerInference.domain_override(name)
            # Domain override returns None or neutral for generic thematic/ADX lists
            if override is not None:
                self.assertEqual(override, 'neutral', f"Failed for {name}")

    def test_screener_defaults_preserves_existing_non_neutral_sentiment(self):
        bias, _, _, _ = sce.resolve_screener_defaults('other', 'bullish', 'Some Custom Screener')
        self.assertEqual(bias, 'bullish')

        bias_bearish, _, _, _ = sce.resolve_screener_defaults('other', 'bearish', 'Some Custom Screener')
        self.assertEqual(bias_bearish, 'bearish')

    def test_known_layer_disagreement_is_visible(self):
        """The oversold/overbought families are labelled OPPOSITELY by the two layers.

        Not a bug being asserted as correct -- a known, recorded conflict (AF-20260829-11)
        pinned so it cannot change silently in either direction. domain_override follows the
        backtest; the write path follows the name. Resolving it needs a measurement, not a
        preference.
        """
        write_path, _, _, _ = sce.resolve_screener_defaults(
            'technical', 'neutral', '15 min CCI Oversold')
        measured = NLPScreenerInference.domain_override('15 min cci oversold')
        self.assertEqual(write_path, 'bullish')
        self.assertEqual(measured, 'bearish')
        self.assertNotEqual(
            write_path, measured,
            "The two layers now agree -- if that was deliberate, delete this test and record "
            "which one won in docs/audit-findings.md AF-20260829-11.")

if __name__ == '__main__':
    unittest.main()
