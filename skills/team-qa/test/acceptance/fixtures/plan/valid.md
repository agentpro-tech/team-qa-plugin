# Test plan fixture

TEAMQA_PLAN_START
{
  "run_id": "tq-20260805-sample-shop",
  "app": "sample-shop",
  "plan_version": 1,
  "lanes": [
    {
      "id": "lane-checkout",
      "scope": ["REQ-CHECKOUT"],
      "parallel_ok": false,
      "vi_sao": ""
    },
    {
      "id": "lane-content",
      "scope": ["REQ-LANDING"],
      "parallel_ok": true,
      "vi_sao": "Does not share checkout data"
    }
  ],
  "tiers": {
    "REQ-CHECKOUT": "FULL",
    "REQ-LANDING": "SMOKE"
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
