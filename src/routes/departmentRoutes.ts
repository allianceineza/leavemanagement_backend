import { Router } from "express";
import { getDepartments } from "../controllers/departmentController";

const router = Router();
router.get("/", getDepartments);

export default router;