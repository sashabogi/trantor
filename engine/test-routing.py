#!/usr/bin/env python3
"""Regression test for capability×cost routing — difficulty-aware escalation + catalog cost.

Runs the real weigh_candidates/blended_cost out of bin/scrooge against SYNTHETIC capability
data (no network, no key), asserting:
  1. catalog cost rides on the capability entry (blended_cost falls back to caps when the
     registry doesn't have the model) — the OpenRouter-routing fix,
  2. cost-weight is difficulty-aware: a cheap-but-decent model wins EASY, while HARD escalates
     to a genuinely stronger model instead of the cheapest-that-clears-the-floor.

Exit 0 = all pass. Used to verify the T2 OpenRouter-routes-by-difficulty change.
"""
import os, sys

HERE = os.path.dirname(os.path.realpath(__file__))
SCROOGE = os.path.join(HERE, "bin", "scrooge")
g = {"__name__": "scr", "__file__": SCROOGE}
exec(compile(open(SCROOGE).read(), "scrooge", "exec"), g)

# Synthetic registry has NO catalog models — cost must come from caps (the OpenRouter case).
reg = {"models": {}, "routing": {}}
caps = {
    "cheap-weak":   {"coding": 20, "cost_in": 0.05, "cost_out": 0.10},   # junk-tier
    "cheap-strong": {"coding": 56, "cost_in": 0.14, "cost_out": 0.28},   # deepseek-flash-like
    "mid-strong":   {"coding": 69, "cost_in": 0.60, "cost_out": 2.40},   # glm-5.2-like
    "frontier":     {"coding": 75, "cost_in": 5.00, "cost_out": 22.50},  # gpt-5.5-like
}
cands = list(caps.keys())

fails = []
def ok(name, cond):
    print(("  ✓ " if cond else "  ✗ ") + name)
    if not cond:
        fails.append(name)

# 1. catalog cost via caps fallback (model absent from registry)
ok("blended_cost falls back to the capability entry for catalog models",
   abs(g["blended_cost"](reg, caps, "frontier") - (0.3 * 5.0 + 0.7 * 22.5)) < 1e-6)
ok("blended_cost is 1e-6 for an entirely unknown model (no crash)",
   g["blended_cost"](reg, caps, "does-not-exist") == 1e-6)

def winner(diff):
    return g["weigh_candidates"](reg, caps, cands, "code", diff)[0][0]

easy, medium, hard = winner("easy"), winner("medium"), winner("hard")
print("  picks → easy=%s medium=%s hard=%s" % (easy, medium, hard))

# 2. difficulty-aware escalation
ok("easy prefers a cheap model (cost-optimized)", caps[easy]["coding"] <= caps["mid-strong"]["coding"])
ok("hard escalates to a stronger model than easy", caps[hard]["coding"] > caps[easy]["coding"])
ok("hard reaches genuine strength (>= mid-strong tier)", caps[hard]["coding"] >= caps["mid-strong"]["coding"])
ok("the junk-tier model never wins any difficulty", "cheap-weak" not in (easy, medium, hard))

print(("\nALL PASS" if not fails else "\nFAILED: %d" % len(fails)))
sys.exit(1 if fails else 0)
