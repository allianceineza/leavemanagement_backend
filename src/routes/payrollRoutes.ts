import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth";
import {
  listComponents,
  createComponent,
  updateComponent,
  getEmployeePayroll,
  setBasicSalary,
  assignComponent,
  endAssignment,
  listRuns,
  createRun,
  calculateRun,
  getRun,
  approveRun,
  deleteRun,
  listMyPayslips,
  getPayslip,
  listSalaries,
  getMySalary,
  markRunPaid,
  exportRun,
} from "../controllers/payrollController";

const router = Router();

router.use(requireAuth);

// Any logged-in person: their own payslips (approved runs only, checked in the controller)
router.get("/my-payslips", listMyPayslips);
router.get("/payslips/:id", getPayslip);

const hr = requireRole("HR");

// Pay components
router.get("/components", hr, listComponents);
router.post("/components", hr, createComponent);
router.put("/components/:id", hr, updateComponent);

// One employee's salary and assigned components
router.get("/employees/:id", hr, getEmployeePayroll);
router.post("/employees/:id/salary", hr, setBasicSalary);
router.post("/employees/:id/components", hr, assignComponent);
router.patch("/assignments/:id/end", hr, endAssignment);

// Monthly payroll runs
router.get("/runs", hr, listRuns);
router.post("/runs", hr, createRun);
router.get("/runs/:id", hr, getRun);
router.post("/runs/:id/calculate", hr, calculateRun);
router.post("/runs/:id/approve", hr, approveRun);
router.delete("/runs/:id", hr, deleteRun);
router.get("/salaries", hr, listSalaries);
router.get("/my-salary", getMySalary);
router.post("/runs/:id/mark-paid", hr, markRunPaid);
router.get("/runs/:id/export", hr, exportRun);

export default router;