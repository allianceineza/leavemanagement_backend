import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth";
import {
  listAwardTypes,
  createAwardType,
  updateAwardType,
  createAward,
  updateAward,
  deleteAward,
  listAwards,
  listMyAwards,
} from "../controllers/awardController";

const router = Router();

router.use(requireAuth);

// Any logged-in person: their own awards
router.get("/my", listMyAwards);

// Award types (HR)
router.get("/types", requireRole("HR"), listAwardTypes);
router.post("/types", requireRole("HR"), createAwardType);
router.put("/types/:id", requireRole("HR"), updateAwardType);

// All awards (a manager sees their own department only)
router.get("/types", requireRole("HR", "Chief", "Manager"), listAwardTypes);

// Giving, correcting and removing awards (HR)
router.post("/", requireRole("HR"), createAward);
router.put("/:id", requireRole("HR"), updateAward);
router.delete("/:id", requireRole("HR"), deleteAward);

export default router;