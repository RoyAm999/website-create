import type { Outcome } from "./types";

export interface ResultsSummary {
  realRecovered: Outcome[];
  demoRecovered: Outcome[];
  funnel: {
    returned: number;
    booked: number;
    closed: number;
    revenue: number;
  };
}

export function summarizeResults(outcomes: Outcome[]): ResultsSummary {
  const realRecovered: Outcome[] = [];
  const demoRecovered: Outcome[] = [];

  for (const outcome of outcomes) {
    if (outcome.response_type !== "interested") continue;
    if (outcome.lead?.is_demo === true) demoRecovered.push(outcome);
    else if (outcome.lead?.is_demo === false) realRecovered.push(outcome);
  }

  return {
    realRecovered,
    demoRecovered,
    funnel: {
      returned: realRecovered.length,
      booked: realRecovered.filter((outcome) => Boolean(outcome.booked_at)).length,
      closed: realRecovered.filter((outcome) => Boolean(outcome.closed_at)).length,
      revenue: realRecovered.reduce(
        (sum, outcome) => sum + (outcome.revenue_confirmed_at ? outcome.revenue_minor ?? 0 : 0),
        0,
      ),
    },
  };
}
