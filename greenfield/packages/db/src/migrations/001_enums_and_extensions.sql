-- Up Migration
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE exchange_code     AS ENUM ('NSE','BSE');
CREATE TYPE security_status   AS ENUM ('listed','suspended','delisted','merged');
CREATE TYPE run_status        AS ENUM ('running','succeeded','failed','skipped','degraded');
CREATE TYPE integration_class AS ENUM ('ingestion','read_through','discovery','supplemental','internal');
CREATE TYPE value_availability AS ENUM ('available','withheld','not_applicable','error');
CREATE TYPE bar_interval      AS ENUM ('1m','5m','15m','1d');
CREATE TYPE action_type       AS ENUM ('dividend','split','bonus','rights','merger','demerger','buyback');
CREATE TYPE event_type        AS ENUM ('announcement','earnings','board_meeting','agm','credit_rating',
                                       'surveillance','insider_trade','bulk_deal','block_deal','ipo');
CREATE TYPE signal_direction  AS ENUM ('long','short','neutral');
CREATE TYPE outcome_label     AS ENUM ('win','loss','neutral','pending','invalid');
CREATE TYPE model_state       AS ENUM ('candidate','shadow','approved','active','retired');
CREATE TYPE dq_severity       AS ENUM ('info','warn','fail');

-- Down Migration
DROP TYPE IF EXISTS dq_severity;
DROP TYPE IF EXISTS model_state;
DROP TYPE IF EXISTS outcome_label;
DROP TYPE IF EXISTS signal_direction;
DROP TYPE IF EXISTS event_type;
DROP TYPE IF EXISTS action_type;
DROP TYPE IF EXISTS bar_interval;
DROP TYPE IF EXISTS value_availability;
DROP TYPE IF EXISTS integration_class;
DROP TYPE IF EXISTS run_status;
DROP TYPE IF EXISTS security_status;
DROP TYPE IF EXISTS exchange_code;
DROP EXTENSION IF EXISTS pgcrypto;
DROP EXTENSION IF EXISTS pg_trgm;
