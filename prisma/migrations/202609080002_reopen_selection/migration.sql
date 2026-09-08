-- Keep the bid that created each payment attempt so its callback can be
-- validated even after a declined attempt reopens bid selection.
ALTER TABLE `PaymentAttempt` ADD COLUMN `bidId` CHAR(36) NULL;

UPDATE `PaymentAttempt` pa
JOIN `Visit` v ON v.id = pa.visitId
SET pa.bidId = v.selectedBidId
WHERE pa.bidId IS NULL AND v.selectedBidId IS NOT NULL;

-- The NOT NULL conversion below intentionally fails if any attempt could not
-- be mapped to an original bid, preventing an unsafe partial rollout.
ALTER TABLE `PaymentAttempt` MODIFY COLUMN `bidId` CHAR(36) NOT NULL;
ALTER TABLE `PaymentAttempt`
  ADD INDEX `PaymentAttempt_bidId_idx` (`bidId`),
  ADD CONSTRAINT `PaymentAttempt_bidId_fkey`
    FOREIGN KEY (`bidId`) REFERENCES `Bid`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- A declined attempt reopens selection. This is intentionally limited to
-- visits whose latest known payment state is declined and which have not
-- already been paid or assigned.
UPDATE `Visit` v
JOIN (
  SELECT pa.visitId, MAX(pa.createdAt) AS latestCreatedAt
  FROM `PaymentAttempt` pa
  GROUP BY pa.visitId
) latest ON latest.visitId = v.id
JOIN `PaymentAttempt` pa
  ON pa.visitId = latest.visitId AND pa.createdAt = latest.latestCreatedAt
SET v.selectedBidId = NULL
WHERE v.status = 'bidding'
  AND pa.status = 'declined'
  AND NOT EXISTS (
    SELECT 1 FROM `PaymentAttempt` successful
    WHERE successful.visitId = v.id AND successful.status = 'succeeded'
  )
  AND NOT EXISTS (
    SELECT 1 FROM `PaymentAttempt` pending
    WHERE pending.visitId = v.id AND pending.status = 'pending'
  );
