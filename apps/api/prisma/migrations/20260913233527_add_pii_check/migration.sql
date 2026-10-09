-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_evaluations" (
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
    "piiDetected" BOOLEAN NOT NULL DEFAULT false,
    "piiMatches" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "evaluations_transcriptId_fkey" FOREIGN KEY ("transcriptId") REFERENCES "transcripts" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_evaluations" ("categoryScores", "createdAt", "domainId", "evalSheetVersion", "failedGatingItems", "gatingResult", "goodPoints", "grade", "id", "improvements", "items", "llmModel", "llmProvider", "profanityDetected", "profanityMatches", "status", "totalMaxScore", "totalScore", "transcriptId") SELECT "categoryScores", "createdAt", "domainId", "evalSheetVersion", "failedGatingItems", "gatingResult", "goodPoints", "grade", "id", "improvements", "items", "llmModel", "llmProvider", "profanityDetected", "profanityMatches", "status", "totalMaxScore", "totalScore", "transcriptId" FROM "evaluations";
DROP TABLE "evaluations";
ALTER TABLE "new_evaluations" RENAME TO "evaluations";
CREATE UNIQUE INDEX "evaluations_transcriptId_key" ON "evaluations"("transcriptId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
