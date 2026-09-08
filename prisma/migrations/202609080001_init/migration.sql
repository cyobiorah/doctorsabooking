-- CreateTable
CREATE TABLE `User` (
    `id` CHAR(36) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `passwordHash` VARCHAR(100) NOT NULL,
    `role` ENUM('patient', 'doctor') NOT NULL,

    UNIQUE INDEX `User_email_key`(`email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Visit` (
    `id` CHAR(36) NOT NULL,
    `patientId` CHAR(36) NOT NULL,
    `specialty` VARCHAR(100) NOT NULL,
    `location` VARCHAR(200) NOT NULL,
    `preferredTime` DATETIME(3) NOT NULL,
    `status` ENUM('open', 'bidding', 'paid', 'assigned') NOT NULL DEFAULT 'open',
    `selectedBidId` CHAR(36) NULL,
    `assignedDoctorId` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `Visit_selectedBidId_key`(`selectedBidId`),
    INDEX `Visit_patientId_createdAt_idx`(`patientId`, `createdAt`),
    INDEX `Visit_status_selectedBidId_idx`(`status`, `selectedBidId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Bid` (
    `id` CHAR(36) NOT NULL,
    `visitId` CHAR(36) NOT NULL,
    `doctorId` CHAR(36) NOT NULL,
    `amount` INTEGER NOT NULL,
    `currency` CHAR(3) NOT NULL DEFAULT 'USD',
    `note` VARCHAR(500) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `Bid_visitId_doctorId_key`(`visitId`, `doctorId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PaymentAttempt` (
    `id` CHAR(36) NOT NULL,
    `visitId` CHAR(36) NOT NULL,
    `amount` INTEGER NOT NULL,
    `currency` CHAR(3) NOT NULL,
    `status` ENUM('pending', 'succeeded', 'declined') NOT NULL DEFAULT 'pending',
    `pendingVisitId` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `PaymentAttempt_pendingVisitId_key`(`pendingVisitId`),
    INDEX `PaymentAttempt_visitId_createdAt_idx`(`visitId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `WebhookEvent` (
    `id` CHAR(36) NOT NULL,
    `attemptId` CHAR(36) NOT NULL,
    `outcome` ENUM('pending', 'succeeded', 'declined') NOT NULL,
    `amount` INTEGER NOT NULL,
    `currency` CHAR(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Transition` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `visitId` CHAR(36) NOT NULL,
    `status` ENUM('open', 'bidding', 'paid', 'assigned') NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Session` (
    `id` VARCHAR(128) NOT NULL,
    `data` TEXT NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,

    INDEX `Session_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `MockPayment` (
    `id` CHAR(36) NOT NULL,
    `token` VARCHAR(64) NOT NULL,
    `eventId` CHAR(36) NOT NULL,
    `amount` INTEGER NOT NULL,
    `currency` CHAR(3) NOT NULL,
    `status` ENUM('pending', 'succeeded', 'declined') NOT NULL DEFAULT 'pending',

    UNIQUE INDEX `MockPayment_token_key`(`token`),
    UNIQUE INDEX `MockPayment_eventId_key`(`eventId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Visit` ADD CONSTRAINT `Visit_patientId_fkey` FOREIGN KEY (`patientId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Visit` ADD CONSTRAINT `Visit_selectedBidId_fkey` FOREIGN KEY (`selectedBidId`) REFERENCES `Bid`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Visit` ADD CONSTRAINT `Visit_assignedDoctorId_fkey` FOREIGN KEY (`assignedDoctorId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Bid` ADD CONSTRAINT `Bid_visitId_fkey` FOREIGN KEY (`visitId`) REFERENCES `Visit`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Bid` ADD CONSTRAINT `Bid_doctorId_fkey` FOREIGN KEY (`doctorId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PaymentAttempt` ADD CONSTRAINT `PaymentAttempt_visitId_fkey` FOREIGN KEY (`visitId`) REFERENCES `Visit`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WebhookEvent` ADD CONSTRAINT `WebhookEvent_attemptId_fkey` FOREIGN KEY (`attemptId`) REFERENCES `PaymentAttempt`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Transition` ADD CONSTRAINT `Transition_visitId_fkey` FOREIGN KEY (`visitId`) REFERENCES `Visit`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

