-- Prevent concurrent requests from creating multiple active/trialing subscriptions
-- for the same user. A partial UNIQUE index is used instead of a table constraint
-- so it only enforces uniqueness for in-flight states, leaving historical
-- cancelled/past_due rows unrestricted.
--
-- The application layer (SELECT … FOR UPDATE before INSERT) is the first line of
-- defence. This index is the hard guarantee that survives any application bug or
-- direct DB write.
CREATE UNIQUE INDEX subscriptions_one_active_per_user_idx
  ON subscriptions (user_id)
  WHERE status IN ('active', 'trialing');
