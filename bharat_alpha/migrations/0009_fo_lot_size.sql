-- Contract lot size (UDiFF `NewBrdLotQty`), carried in the F&O bhavcopy we already download.
-- OpnIntrst is a count of CONTRACTS, so open interest is only comparable over time — and across
-- stocks — once multiplied by the lot. NSE revises lots to keep contract value inside its band,
-- and each revision moves the contract count with no change in real exposure.
ALTER TABLE alpha.fo_daily ADD COLUMN IF NOT EXISTS lot_size DOUBLE PRECISION;
