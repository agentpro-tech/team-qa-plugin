# Report plan fixture

TEAMQA_PLAN_START
{
  "run_id": "tq-report",
  "app": "sample-shop",
  "plan_version": 1,
  "lanes": [
    {"id": "lane-high", "scope": ["REQ-HIGH-1", "REQ-HIGH-2"], "parallel_ok": false, "vi_sao": ""},
    {"id": "lane-low", "scope": ["REQ-LOW-1", "REQ-LOW-2"], "parallel_ok": false, "vi_sao": ""}
  ],
  "tiers": {
    "REQ-HIGH-1": "FULL",
    "REQ-HIGH-2": "FULL",
    "REQ-LOW-1": "SMOKE",
    "REQ-LOW-2": "SMOKE"
  },
  "exit_criteria": {
    "p0_max": 0,
    "p1_max": 0,
    "p1_waivers": [],
    "coverage_high_pct": 100,
    "coverage_low_pct": 70
  }
}
TEAMQA_PLAN_END
