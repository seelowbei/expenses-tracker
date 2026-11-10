-- System default categories (user_id NULL). Keep in sync with src/agent/categories.ts.
INSERT INTO `categories` (`id`, `user_id`, `slug`, `name`) VALUES
  ('sys_food-dining', NULL, 'food-dining', 'Food & Dining'),
  ('sys_groceries', NULL, 'groceries', 'Groceries'),
  ('sys_transport', NULL, 'transport', 'Transport'),
  ('sys_travel', NULL, 'travel', 'Travel'),
  ('sys_utilities', NULL, 'utilities', 'Utilities'),
  ('sys_housing', NULL, 'housing', 'Housing'),
  ('sys_shopping', NULL, 'shopping', 'Shopping'),
  ('sys_health', NULL, 'health', 'Health'),
  ('sys_entertainment', NULL, 'entertainment', 'Entertainment'),
  ('sys_education', NULL, 'education', 'Education'),
  ('sys_subscriptions', NULL, 'subscriptions', 'Subscriptions'),
  ('sys_business', NULL, 'business', 'Business'),
  ('sys_other', NULL, 'other', 'Other');
