-- Personal invites (2026-10-22): an invite can be bound to one phone/email.
-- Registration with such a code only works for that exact contact, so a code
-- handed to a specific person cannot be used to register someone else's contact.
ALTER TABLE invites ADD COLUMN contact TEXT;
