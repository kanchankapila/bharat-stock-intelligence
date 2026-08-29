"""
Unit tests for WorkflowDAG and TaskNode execution ordering and retry logic.
"""

import pytest
from workflow_orchestrator import WorkflowDAG


def test_dag_execution_topological_order():
    execution_order = []

    def task_a():
        execution_order.append("A")
        return "result_A"

    def task_b():
        execution_order.append("B")
        return "result_B"

    dag = WorkflowDAG("test_pipeline")
    dag.add_task("task_a", task_a)
    dag.add_task("task_b", task_b, dependencies=["task_a"])

    res = dag.execute()
    assert res["success"] is True
    assert set(res["completed"]) == {"task_a", "task_b"}
    assert execution_order == ["A", "B"]
    assert res["results"]["task_a"] == "result_A"


def test_dag_retry_behavior():
    attempts = 0

    def flaky_task():
        nonlocal attempts
        attempts += 1
        if attempts < 2:
            raise ValueError("Temporary glitch")
        return "recovered"

    dag = WorkflowDAG("flaky_pipeline")
    dag.add_task("flaky", flaky_task, max_retries=3, retry_delay_sec=0.01)

    res = dag.execute()
    assert res["success"] is True
    assert attempts == 2
