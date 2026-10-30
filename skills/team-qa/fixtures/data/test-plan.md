# Team QA fixture plan

TEAMQA_PLAN_START
{
  "run_id": "fixture-run",
  "app": "fixture-app",
  "plan_version": 1,
  "lanes": [
    {"id": "lane-high", "scope": ["REQ-HIGH"], "parallel_ok": false, "vi_sao": ""},
    {"id": "lane-low", "scope": ["REQ-LOW"], "parallel_ok": false, "vi_sao": ""}
  ],
  "tiers": {"REQ-HIGH": "FULL", "REQ-LOW": "SMOKE"},
  "exit_criteria": {
    "p0_max": 0,
    "p1_max": 0,
    "p1_waivers": [],
    "coverage_high_pct": 100,
    "coverage_low_pct": 70
  }
}
TEAMQA_PLAN_END
