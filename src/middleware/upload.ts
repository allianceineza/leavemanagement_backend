import type { Request, Response, NextFunction } from "express";
import multer from "multer";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});

export function uploadDocument(req: Request, res: Response, next: NextFunction): void {
  upload.single("document")(req, res, (err: unknown) => {
    if (err) {
      const code = (err as { code?: string }).code;
      res.status(400).json({
        message:
          code === "LIMIT_FILE_SIZE"
            ? "The file is too large. The maximum size is 5 MB."
            : "Could not read the uploaded file.",
      });
      return;
    }
    next();
  });
}