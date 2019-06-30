UPDATE pool.config SET item_value = '' WHERE module = 'pool' and item = 'address';
UPDATE pool.config SET item_value = '' WHERE module = 'payout' and item = 'feeAddress';
UPDATE pool.config SET item_value = '' WHERE module = 'general' and item = 'mailgunKey';
UPDATE pool.config SET item_value = '' WHERE module = 'general' and item = 'mailgunURL';
UPDATE pool.config SET item_value = '' WHERE module = 'general' and item = 'emailFrom';
UPDATE pool.config SET item_value = 'http://127.0.0.1:8000/leafApi' WHERE module = 'general' and item = 'shareHost';
