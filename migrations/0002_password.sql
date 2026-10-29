-- Password-based login (2026-10-22): each employee sets their own password
-- at invite registration; login verifies password_hash (PBKDF2, same format as pin_hash).
-- pin_hash remains only as the kiosk clock-in credential / legacy fallback.
ALTER TABLE employees ADD COLUMN password_hash TEXT;
