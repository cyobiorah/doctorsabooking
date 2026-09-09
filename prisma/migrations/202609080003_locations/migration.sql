-- Add the shared service-area catalog and doctor coverage links.
CREATE TABLE `Location` (
    `id` CHAR(36) NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `slug` VARCHAR(100) NOT NULL,
    `country` VARCHAR(100) NOT NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `Location_slug_key`(`slug`),
    INDEX `Location_active_name_idx`(`active`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `Location` (`id`, `name`, `slug`, `country`, `active`) VALUES
  ('00000000-0000-4000-8000-000000000001', 'Lagos', 'lagos', 'Nigeria', true),
  ('00000000-0000-4000-8000-000000000002', 'Abuja', 'abuja', 'Nigeria', true),
  ('00000000-0000-4000-8000-000000000003', 'London', 'london', 'United Kingdom', true),
  ('00000000-0000-4000-8000-000000000004', 'New York', 'new-york', 'United States', true),
  ('00000000-0000-4000-8000-000000000005', 'Dubai', 'dubai', 'United Arab Emirates', true),
  ('00000000-0000-4000-8000-000000000099', 'Legacy location', 'legacy-location', 'Unknown', false);

CREATE TABLE `DoctorLocation` (
    `doctorId` CHAR(36) NOT NULL,
    `locationId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `DoctorLocation_locationId_doctorId_idx`(`locationId`, `doctorId`),
    PRIMARY KEY (`doctorId`, `locationId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `Visit` ADD COLUMN `locationId` CHAR(36) NULL;

UPDATE `Visit` v
JOIN `Location` l
  ON LOWER(TRIM(v.`location`)) = LOWER(l.`name`)
SET v.`locationId` = l.`id`
WHERE l.`active` = true;

UPDATE `Visit`
SET `locationId` = '00000000-0000-4000-8000-000000000099'
WHERE `locationId` IS NULL;

ALTER TABLE `Visit` MODIFY COLUMN `locationId` CHAR(36) NOT NULL;
ALTER TABLE `Visit`
  ADD INDEX `Visit_locationId_idx`(`locationId`),
  ADD CONSTRAINT `Visit_locationId_fkey`
    FOREIGN KEY (`locationId`) REFERENCES `Location`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `DoctorLocation`
  ADD CONSTRAINT `DoctorLocation_doctorId_fkey`
    FOREIGN KEY (`doctorId`) REFERENCES `User`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `DoctorLocation_locationId_fkey`
    FOREIGN KEY (`locationId`) REFERENCES `Location`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;
