-- CreateTable
CREATE TABLE "transcripts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "domainId" TEXT NOT NULL,
    "maskedText" TEXT NOT NULL,
    "metadata" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "evaluations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "transcriptId" TEXT NOT NULL,
    "domainId" TEXT NOT NULL,
    "evalSheetVersion" TEXT NOT NULL,
    "llmProvider" TEXT NOT NULL,
    "llmModel" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'completed',
    "items" TEXT NOT NULL,
    "categoryScores" TEXT NOT NULL,
    "totalScore" INTEGER NOT NULL,
    "totalMaxScore" INTEGER NOT NULL,
    "grade" TEXT NOT NULL,
    "gatingResult" TEXT NOT NULL,
    "failedGatingItems" TEXT NOT NULL,
    "goodPoints" TEXT NOT NULL,
    "improvements" TEXT NOT NULL,
    "profanityDetected" BOOLEAN NOT NULL,
    "profanityMatches" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "evaluations_transcriptId_fkey" FOREIGN KEY ("transcriptId") REFERENCES "transcripts" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "evaluations_transcriptId_key" ON "evaluations"("transcriptId");
