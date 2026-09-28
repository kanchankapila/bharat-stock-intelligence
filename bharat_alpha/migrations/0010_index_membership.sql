-- Index membership as intervals, built by diffing the constituent list we already fetch daily.
-- The list itself is a snapshot with no history, so a join or exit is only knowable from the day
-- we first SEE the change — which is what makes these events point-in-time honest.
CREATE TABLE IF NOT EXISTS alpha.index_membership (
    index_name      TEXT NOT NULL,
    instrument_id   INT NOT NULL REFERENCES alpha.instrument(instrument_id),
    from_date       DATE NOT NULL,              -- first session we saw it in the list
    to_date         DATE,                       -- last session we saw it; NULL = still a member
    source          TEXT NOT NULL,
    PRIMARY KEY (index_name, instrument_id, from_date)
);
CREATE INDEX IF NOT EXISTS index_membership_open ON alpha.index_membership(index_name, instrument_id) WHERE to_date IS NULL;
