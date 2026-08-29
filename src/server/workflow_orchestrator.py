"""
Pipeline Workflow Orchestrator & DAG Execution Engine.

Provides dependency-aware task graphs with state preservation, automatic retries,
and step execution tracking for ingestion and ML pipelines.
"""

import polars as pl
import logging
import time
from typing import Any, Callable, Dict, List, Optional, Set

logger = logging.getLogger("workflow_orchestrator")


class TaskNode:
    def __init__(
        self,
        name: str,
        fn: Callable[[], Any],
        dependencies: Optional[List[str]] = None,
        max_retries: int = 3,
        retry_delay_sec: float = 2.0,
    ):
        self.name = name
        self.fn = fn
        self.dependencies: Set[str] = set(dependencies or [])
        self.max_retries = max_retries
        self.retry_delay_sec = retry_delay_sec
        self.status: str = "PENDING"  # PENDING, RUNNING, SUCCESS, FAILED
        self.error: Optional[str] = None
        self.start_time: Optional[float] = None
        self.end_time: Optional[float] = None


class WorkflowDAG:
    def __init__(self, name: str):
        self.name = name
        self.tasks: Dict[str, TaskNode] = {}

    def add_task(
        self,
        name: str,
        fn: Callable[[], Any],
        dependencies: Optional[List[str]] = None,
        max_retries: int = 3,
        retry_delay_sec: float = 2.0,
    ) -> "WorkflowDAG":
        self.tasks[name] = TaskNode(
            name=name,
            fn=fn,
            dependencies=dependencies,
            max_retries=max_retries,
            retry_delay_sec=retry_delay_sec,
        )
        return self

    def execute(self) -> Dict[str, Any]:
        """Executes task graph in topological order respecting dependencies."""
        completed: Set[str] = set()
        failed: Set[str] = set()
        results: Dict[str, Any] = {}

        while len(completed) + len(failed) < len(self.tasks):
            ready_tasks = [
                t for t in self.tasks.values()
                if t.status == "PENDING" and t.dependencies.issubset(completed)
            ]

            if not ready_tasks:
                if any(t.status == "PENDING" for t in self.tasks.values()):
                    logger.error("[%s] Blocked tasks due to failed dependencies: %s", self.name, failed)
                break

            for task in ready_tasks:
                task.status = "RUNNING"
                task.start_time = time.time()
                task_success = False

                for attempt in range(1, task.max_retries + 1):
                    try:
                        logger.info("[%s] Executing task '%s' (attempt %d)", self.name, task.name, attempt)
                        res = task.fn()
                        results[task.name] = res
                        task.status = "SUCCESS"
                        completed.add(task.name)
                        task_success = True
                        break
                    except Exception as exc:
                        task.error = str(exc)
                        logger.warning("[%s] Task '%s' failed (attempt %d): %s", self.name, task.name, attempt, exc)
                        time.sleep(task.retry_delay_sec)

                if not task_success:
                    task.status = "FAILED"
                    failed.add(task.name)

                task.end_time = time.time()

        return {
            "workflow": self.name,
            "success": len(failed) == 0,
            "completed": list(completed),
            "failed": list(failed),
            "results": results,
        }



def build_daily_ml_pipeline_dag() -> WorkflowDAG:
    """Constructs the canonical Daily ML & Inference Pipeline DAG."""
    dag = WorkflowDAG("daily_ml_pipeline")
    dag.add_task("bhavcopy_fetcher", lambda: logger.info("Step: Bhavcopy Ingestion"), max_retries=3)
    dag.add_task("ohlcv_quality", lambda: logger.info("Step: OHLCV Quality Checks"), dependencies=["bhavcopy_fetcher"])
    dag.add_task("technical_signals", lambda: logger.info("Step: Technical Analysis Signals"), dependencies=["ohlcv_quality"])
    dag.add_task("densify_matrix", lambda: logger.info("Step: Densify Feature Matrix"), dependencies=["technical_signals"])
    dag.add_task("ml_ensemble", lambda: logger.info("Step: ML Ensemble Training & Scoring"), dependencies=["densify_matrix"])
    dag.add_task("unified_ranker", lambda: logger.info("Step: Unified Ranker Execution"), dependencies=["ml_ensemble"])
    return dag


def build_intraday_pipeline_dag() -> WorkflowDAG:
    """Constructs the Intraday Regime & Ranker Pipeline DAG."""
    dag = WorkflowDAG("intraday_pipeline")
    dag.add_task("pcr_fetch", lambda: logger.info("Step: PCR/GEX Fetch"), max_retries=3)
    dag.add_task("intraday_regime", lambda: logger.info("Step: Intraday Regime Calculation"), dependencies=["pcr_fetch"])
    dag.add_task("intraday_ranker", lambda: logger.info("Step: Intraday Ranker Execution"), dependencies=["intraday_regime"])
    return dag


def run_pipeline(pipeline_name: str) -> Dict[str, Any]:
    """Runs a pre-defined pipeline DAG by name."""
    if pipeline_name == "daily_ml":
        return build_daily_ml_pipeline_dag().execute()
    elif pipeline_name == "intraday":
        return build_intraday_pipeline_dag().execute()
    else:
        raise ValueError(f"Unknown pipeline: {pipeline_name}")


if __name__ == "__main__":
    import sys
    import json

    pipeline = sys.argv[1] if len(sys.argv) > 1 else "daily_ml"
    res = run_pipeline(pipeline)
    print(json.dumps(res, indent=2))

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
