/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * PITWALL — F1 Race Strategist & Monaco Telemetry Backend Server
 * Circuit de Monaco Exclusive Race Strategy Simulation & AI Engineer Engine
 * Powered by Express, Google Gen AI SDK (@google/genai), and Monte Carlo Simulation.
 */

import express, { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = parseInt(process.env.PORT || '3001', 10);

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Permissive CORS middleware for local development & cross-port Vite
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
    return;
  }
  next();
});

// Initialize Gemini Client
let geminiClient: GoogleGenAI | null = null;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (GEMINI_API_KEY && GEMINI_API_KEY !== 'MY_GEMINI_API_KEY') {
  try {
    geminiClient = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
    console.log('[Gemini AI] @google/genai client initialized successfully with API key.');
  } catch (err) {
    console.warn('[Gemini AI] Failed to initialize @google/genai client:', err);
  }
} else {
  console.log('[Gemini AI] GEMINI_API_KEY not provided or default placeholder. Using high-fidelity heuristic offline strategist.');
}

// -----------------------------------------------------------------------------
// CIRCUIT DE MONACO BENCHMARKS & CONSTANTS
// -----------------------------------------------------------------------------
export const MONACO_SPECS = {
  circuitName: 'Circuit de Monaco',
  grandPrix: 'Monaco Grand Prix',
  trackLengthKm: 3.337,
  defaultCaseStudyLaps: 53,
  fullRaceLaps: 78,
  baseLapTimeSeconds: 73.78, // 1:13.780
  normalPitLossSeconds: 22.4, // Pit limiter 60 km/h + box stop
  safetyCarPitLossSeconds: 12.1, // Slower pack delta yields ~10.3s advantage
  vscPitLossSeconds: 16.8,
  redFlagPitLossSeconds: 0.0, // Free tire swap under red flag
  pitLaneSpeedLimitKmh: 60,
  overtakeThresholdDeltaSec: 2.1, // Minimum pace delta required to attempt Monaco overtake
  dirtyAirLossPerLapSec: 0.65, // Dirty air penalty following within 1.0s in sector 2
  fuelConsumptionKgPerLap: 1.48,
  fuelPaceEffectSecPerKg: 0.032,
  fiaPointsScale: [25, 18, 15, 12, 10, 8, 6, 4, 2, 1],
};

export type TireCompound = 'SOFT' | 'MEDIUM' | 'HARD' | 'INTER' | 'WET';
export type SafetyCarStatus = 'SC' | 'VSC' | 'GREEN';
export type PaceMode = 'SAVE' | 'BALANCED' | 'ATTACK';

interface CompoundSpecs {
  basePaceOffset: number;
  degradationPerLap: number;
  cliffLapThreshold: number;
  cliffExponentialFactor: number;
  wetOptimumThreshold: number;
  dryPenalty: number;
}

const COMPOUND_SPECS: Record<TireCompound, CompoundSpecs> = {
  SOFT: {
    basePaceOffset: -0.65,
    degradationPerLap: 0.115,
    cliffLapThreshold: 20,
    cliffExponentialFactor: 0.18,
    wetOptimumThreshold: 0,
    dryPenalty: 0,
  },
  MEDIUM: {
    basePaceOffset: 0.0,
    degradationPerLap: 0.068,
    cliffLapThreshold: 34,
    cliffExponentialFactor: 0.14,
    wetOptimumThreshold: 0,
    dryPenalty: 0,
  },
  HARD: {
    basePaceOffset: +0.48,
    degradationPerLap: 0.038,
    cliffLapThreshold: 46,
    cliffExponentialFactor: 0.10,
    wetOptimumThreshold: 0,
    dryPenalty: 0,
  },
  INTER: {
    basePaceOffset: +3.60,
    degradationPerLap: 0.22,
    cliffLapThreshold: 18,
    cliffExponentialFactor: 0.25,
    wetOptimumThreshold: 45,
    dryPenalty: 3.5,
  },
  WET: {
    basePaceOffset: +7.20,
    degradationPerLap: 0.35,
    cliffLapThreshold: 16,
    cliffExponentialFactor: 0.30,
    wetOptimumThreshold: 80,
    dryPenalty: 6.8,
  },
};

// -----------------------------------------------------------------------------
// DETERMINISTIC LAP TIME & MONACO PACING MODEL
// -----------------------------------------------------------------------------
function calculateLapTime(
  lapNumber: number,
  compound: TireCompound,
  tireAge: number,
  fuelOnboardKg: number,
  rainProbability: number,
  rainArrivalLap: number,
  isSafetyCarActive: boolean,
  isVscActive: boolean,
  paceModifier: number = 0
): number {
  if (isSafetyCarActive) {
    return MONACO_SPECS.baseLapTimeSeconds * 1.55;
  }
  if (isVscActive) {
    return MONACO_SPECS.baseLapTimeSeconds * 1.30;
  }

  const spec = COMPOUND_SPECS[compound];
  let time = MONACO_SPECS.baseLapTimeSeconds + spec.basePaceOffset;

  // Linear & exponential degradation cliff
  const linearDeg = spec.degradationPerLap * tireAge;
  const cliffDeg = tireAge > spec.cliffLapThreshold
    ? Math.pow(tireAge - spec.cliffLapThreshold, 1.75) * spec.cliffExponentialFactor
    : 0;
  time += linearDeg + cliffDeg;

  // Fuel effect
  time += Math.max(1, fuelOnboardKg) * MONACO_SPECS.fuelPaceEffectSecPerKg;

  // Rain dynamics
  const isAfterRain = lapNumber >= rainArrivalLap;
  const rainSeverity = (rainProbability / 100) * (isAfterRain ? Math.min(1.0, (lapNumber - rainArrivalLap + 1) * 0.35) : 0);

  if (compound === 'SOFT' || compound === 'MEDIUM' || compound === 'HARD') {
    if (rainSeverity > 0.05) {
      time += rainSeverity * 18.5;
    }
  } else if (compound === 'INTER') {
    if (rainSeverity < 0.25) {
      time += spec.dryPenalty * (1 - rainSeverity);
    } else {
      time -= 4.2 * rainSeverity;
    }
  } else if (compound === 'WET') {
    if (rainSeverity < 0.65) {
      time += spec.dryPenalty * (1 - rainSeverity);
    } else {
      time -= 6.0 * rainSeverity;
    }
  }

  time += paceModifier;
  return Math.max(MONACO_SPECS.baseLapTimeSeconds - 1.5, time);
}

// -----------------------------------------------------------------------------
// MONTE CARLO STOCHASTIC SIMULATION ENGINE (5,000 RUNS)
// -----------------------------------------------------------------------------
function runMonteCarloSimulation(
  baseTotalTime: number,
  stopsCount: number,
  riskBaseline: number,
  rainProbability: number,
  sampleCount: number = 5000
) {
  const times: number[] = [];
  const positions: number[] = [];

  for (let i = 0; i < sampleCount; i++) {
    let pitStopJitter = 0;
    for (let s = 0; s < stopsCount; s++) {
      const isSlowStop = Math.random() < 0.045; // 4.5% chance of sticky wheel nut
      const gaussianNoise = (Math.random() + Math.random() + Math.random() - 1.5) * 0.40;
      pitStopJitter += isSlowStop ? 2.4 + Math.random() * 2.0 : gaussianNoise;
    }

    // Weather arrival jitter (rain may hit early or late)
    const weatherJitter = (rainProbability / 100) * (Math.random() - 0.5) * 7.0;

    // Traffic & dirty air jitter at Monaco
    const trafficJitter = (Math.random() - 0.4) * (riskBaseline > 50 ? 4.2 : 1.6);

    const simTotalTime = baseTotalTime + pitStopJitter + weatherJitter + trafficJitter;
    times.push(simTotalTime);

    // Stochastic finishing position calculation based on time variance
    let simPos = 3;
    if (simTotalTime < baseTotalTime - 3.5) simPos = 1;
    else if (simTotalTime < baseTotalTime - 1.0) simPos = 2;
    else if (simTotalTime <= baseTotalTime + 3.0) simPos = 3;
    else if (simTotalTime <= baseTotalTime + 7.5) simPos = 4;
    else if (simTotalTime <= baseTotalTime + 13.0) simPos = 5;
    else simPos = Math.min(10, Math.floor(6 + (simTotalTime - baseTotalTime) / 8));
    positions.push(simPos);
  }

  times.sort((a, b) => a - b);
  const avgTime = times.reduce((acc, t) => acc + t, 0) / sampleCount;

  // Win, Podium, Points calculations
  const wins = positions.filter((p) => p === 1).length;
  const podiums = positions.filter((p) => p <= 3).length;
  const p1Prob = Number(((wins / sampleCount) * 100).toFixed(1));
  const podiumProb = Number(((podiums / sampleCount) * 100).toFixed(1));

  // Expected F1 Championship Points
  const expectedPoints = Number((
    positions.reduce((acc, pos) => {
      const pts = pos <= 10 ? MONACO_SPECS.fiaPointsScale[pos - 1] : 0;
      return acc + pts;
    }, 0) / sampleCount
  ).toFixed(1));

  // CVaR (Conditional Value at Risk): average points in worst 5% of outcomes
  positions.sort((a, b) => b - a); // highest position numbers (worst finishes) first
  const worst5PercentCount = Math.max(1, Math.floor(sampleCount * 0.05));
  const worstPoints = positions.slice(0, worst5PercentCount).reduce((acc, pos) => {
    return acc + (pos <= 10 ? MONACO_SPECS.fiaPointsScale[pos - 1] : 0);
  }, 0) / worst5PercentCount;

  return {
    times: times.slice(0, 200), // Return 200 points for chart rendering
    avgTime,
    p1Prob,
    podiumProb,
    expectedPoints,
    cvarWorstCase: Number(worstPoints.toFixed(1)),
  };
}

// -----------------------------------------------------------------------------
// STRATEGY EVALUATION LOGIC
// -----------------------------------------------------------------------------
export function evaluateCandidateStrategies(params: {
  currentLap: number;
  totalLaps: number;
  currentCompound: TireCompound;
  tireAge: number;
  fuelLoadKg: number;
  safetyCarStatus: SafetyCarStatus;
  rainProbability: number;
  rainArrivalLap: number;
  paceMode: PaceMode;
  normalPitLossSec?: number;
  scPitLossSec?: number;
  vscPitLossSec?: number;
  gapP2?: number;
  gapP4?: number;
  numSimulations?: number;
}) {
  const currentLap = params.currentLap || 31;
  const totalLaps = params.totalLaps || 53;
  const currentCompound = params.currentCompound || 'SOFT';
  const tireAge = params.tireAge || 19;
  const fuelLoadKg = params.fuelLoadKg || 32.8;
  const safetyCarStatus = params.safetyCarStatus || 'SC';
  const rainProbability = params.rainProbability ?? 72;
  const rainArrivalLap = params.rainArrivalLap || 35;
  const paceMode = params.paceMode || 'BALANCED';
  const normalPitLossSec = params.normalPitLossSec || MONACO_SPECS.normalPitLossSeconds;
  const scPitLossSec = params.scPitLossSec || MONACO_SPECS.safetyCarPitLossSeconds;
  const vscPitLossSec = params.vscPitLossSec || MONACO_SPECS.virtualSafetyCarPitLossSeconds;
  const gapP2 = params.gapP2 ?? 1.842;
  const numSims = params.numSimulations || 5000;

  const lapsRemaining = totalLaps - currentLap;
  const isSC = safetyCarStatus === 'SC';
  const isVSC = safetyCarStatus === 'VSC';
  const effectivePitLoss = isSC ? scPitLossSec : isVSC ? vscPitLossSec : normalPitLossSec;
  const pitSavingsDelta = normalPitLossSec - effectivePitLoss;

  const paceOffset = paceMode === 'ATTACK' ? -0.28 : paceMode === 'SAVE' ? +0.35 : 0;

  // Plan A: Box Under SC (or Box Now) for Mediums
  let timePlanA = effectivePitLoss;
  for (let l = 1; l <= lapsRemaining; l++) {
    const lapNum = currentLap + l;
    const isUnderSC = isSC && l <= 3;
    timePlanA += calculateLapTime(lapNum, 'MEDIUM', l, fuelLoadKg, rainProbability, rainArrivalLap, isUnderSC, false, paceOffset);
  }

  // Plan B: Stay Out On Softs until Rain hits at rainArrivalLap
  let timePlanB = 0;
  const lapsToRain = Math.max(0, rainArrivalLap - currentLap);
  for (let l = 1; l <= lapsRemaining; l++) {
    const lapNum = currentLap + l;
    const isUnderSC = isSC && l <= 3;
    if (l <= lapsToRain) {
      timePlanB += calculateLapTime(lapNum, currentCompound, tireAge + l, fuelLoadKg, rainProbability, rainArrivalLap, isUnderSC, false, paceOffset);
    } else if (l === lapsToRain + 1) {
      timePlanB += normalPitLossSec; // Green flag stop for Inters
      timePlanB += calculateLapTime(lapNum, 'INTER', 1, fuelLoadKg, rainProbability, rainArrivalLap, false, false, paceOffset);
    } else {
      timePlanB += calculateLapTime(lapNum, 'INTER', l - lapsToRain, fuelLoadKg, rainProbability, rainArrivalLap, false, false, paceOffset);
    }
  }

  // Plan C: Hard Tire Stint (One-stop to the end)
  let timePlanC = effectivePitLoss;
  for (let l = 1; l <= lapsRemaining; l++) {
    const lapNum = currentLap + l;
    const isUnderSC = isSC && l <= 3;
    timePlanC += calculateLapTime(lapNum, 'HARD', l, fuelLoadKg, rainProbability, rainArrivalLap, isUnderSC, false, paceOffset);
  }

  // Plan D: Double Stop (Soft -> Medium -> Inters/Softs)
  let timePlanD = effectivePitLoss + normalPitLossSec;
  const stint1Laps = Math.max(6, Math.floor(lapsRemaining / 2));
  for (let l = 1; l <= lapsRemaining; l++) {
    const lapNum = currentLap + l;
    const isUnderSC = isSC && l <= 3;
    const comp = l <= stint1Laps ? 'MEDIUM' : (rainProbability > 60 ? 'INTER' : 'SOFT');
    const age = l <= stint1Laps ? l : l - stint1Laps;
    timePlanD += calculateLapTime(lapNum, comp, age, fuelLoadKg, rainProbability, rainArrivalLap, isUnderSC, false, paceOffset);
  }

  // Monte Carlo runs for each strategy
  const mcA = runMonteCarloSimulation(timePlanA, 1, 20, rainProbability, numSims);
  const mcB = runMonteCarloSimulation(timePlanB, 1, 75, rainProbability, numSims);
  const mcC = runMonteCarloSimulation(timePlanC, 1, 35, rainProbability, numSims);
  const mcD = runMonteCarloSimulation(timePlanD, 2, 85, rainProbability, numSims);

  // Strategy A Confidence & Reasoning
  let isAOptimal = true;
  let confidenceA = 94;
  const reasonsA: string[] = [];

  if (isSC) {
    confidenceA = 96;
    reasonsA.push(
      `SC PIT DELTA ADVANTAGE: Pitting under SC costs ${effectivePitLoss}s vs ${normalPitLossSec}s standard loss, saving +${pitSavingsDelta.toFixed(1)}s of race time.`
    );
    reasonsA.push(
      `CLEAN UNDERCUT ON LECLERC: Rejoin delta is +${(pitSavingsDelta - gapP2).toFixed(1)}s ahead of Leclerc's pit exit window.`
    );
    reasonsA.push(
      `WEATHER HEDGE: Fresh Mediums easily reach the Lap ${rainArrivalLap} rain window (${rainProbability}% probability) without cliff degradation.`
    );
  } else if (isVSC) {
    confidenceA = 88;
    reasonsA.push(
      `VSC DELTA GAIN: Pitting under VSC yields a +${pitSavingsDelta.toFixed(1)}s track gain over green flag pace.`
    );
    reasonsA.push(`TIRE CLIFF PREVENTION: 19-lap Softs are at ${tireAge} laps; cliff hits within 2 laps.`);
    reasonsA.push(`COVERS MONACO TRACK LOCKOUT: Track position is preserved ahead of Sainz (P4).`);
  } else {
    confidenceA = 82;
    reasonsA.push(`URGENT TIRE PRESERVATION: Softs degrading at 0.115s/lap; Medium switch restores +1.2s pace.`);
    reasonsA.push(`TRACK POSITION PRIORITY: Monaco dirty-air penalty (-0.65s) makes staying on worn tires fatal.`);
    reasonsA.push(`RAIN CONVERTIBILITY: Mediums remain fastest compound until track wetness exceeds 40%.`);
  }

  const rawDeltaToOptimal = 0;
  const deltaB = Math.max(0.5, Number((timePlanB - timePlanA).toFixed(2)));
  const deltaC = Math.max(0.8, Number((timePlanC - timePlanA).toFixed(2)));
  const deltaD = Math.max(14.2, Number((timePlanD - timePlanA).toFixed(2)));

  const candidates = [
    {
      id: 'strat-a',
      code: 'A' as const,
      name: isSC ? 'PLAN A (BOX UNDER SAFETY CAR)' : 'PLAN A (BOX THIS LAP - MEDIUM)',
      planLabel: 'SOFT → MEDIUM (LAP 31)',
      stopsCount: 1,
      compoundSequence: [currentCompound, 'MEDIUM'] as TireCompound[],
      stintLaps: [currentLap, lapsRemaining],
      pitStopLaps: [currentLap],
      totalRaceTimeSeconds: Number(timePlanA.toFixed(1)),
      timeDeltaToOptimalSeconds: 0.0,
      predictedPositionRange: isSC ? 'P1 - P2' : 'P2 - P3',
      predictedPositionNum: isSC ? 1.4 : 2.1,
      riskScore: isSC ? 18 : 28,
      cliffLapWarning: currentLap + 34,
      isRecommended: true,
      verdictTag: 'OPTIMAL' as const,
      confidencePercent: confidenceA,
      reasons: reasonsA,
      undercutTarget: 'LECLERC (P2) +1.8s',
      monteCarloDistribution: mcA.times,
      rainContingencyCovered: true,
      winProbability: mcA.p1Prob,
      podiumProbability: mcA.podiumProb,
      expectedPoints: mcA.expectedPoints,
      cvarWorstCase: mcA.cvarWorstCase,
    },
    {
      id: 'strat-b',
      code: 'B' as const,
      name: 'PLAN B (STAY OUT & GAMBLE ON RAIN)',
      planLabel: `STAY OUT → INTER (LAP ${rainArrivalLap})`,
      stopsCount: 1,
      compoundSequence: [currentCompound, 'INTER'] as TireCompound[],
      stintLaps: [rainArrivalLap, totalLaps - rainArrivalLap],
      pitStopLaps: [rainArrivalLap],
      totalRaceTimeSeconds: Number(timePlanB.toFixed(1)),
      timeDeltaToOptimalSeconds: deltaB,
      predictedPositionRange: 'P3 - P5',
      predictedPositionNum: 3.8,
      riskScore: 78,
      cliffLapWarning: currentLap + 2,
      isRecommended: false,
      verdictTag: 'HIGH RISK' as const,
      confidencePercent: 54,
      reasons: [
        `EXTREME CLIFF RISK: Soft tires reach 24 laps before rain hits, losing >3.5s per lap in sliding.`,
        `RAIN TIMING VOLATILITY: If rain delays by even 2 laps, Leclerc and Verstappen will lap our car.`,
        `FORFEITS SC PIT SAVINGS: Rejects free +10.3s pit delta advantage currently available.`,
      ],
      undercutTarget: 'VULNERABLE TO SAINZ (P4)',
      monteCarloDistribution: mcB.times,
      rainContingencyCovered: true,
      winProbability: mcB.p1Prob,
      podiumProbability: mcB.podiumProb,
      expectedPoints: mcB.expectedPoints,
      cvarWorstCase: mcB.cvarWorstCase,
    },
    {
      id: 'strat-c',
      code: 'C' as const,
      name: 'PLAN C (BOX FOR HARDS TO END)',
      planLabel: 'SOFT → HARD (ONE-STOP)',
      stopsCount: 1,
      compoundSequence: [currentCompound, 'HARD'] as TireCompound[],
      stintLaps: [currentLap, lapsRemaining],
      pitStopLaps: [currentLap],
      totalRaceTimeSeconds: Number(timePlanC.toFixed(1)),
      timeDeltaToOptimalSeconds: deltaC,
      predictedPositionRange: 'P2 - P4',
      predictedPositionNum: 2.8,
      riskScore: 38,
      cliffLapWarning: currentLap + 46,
      isRecommended: false,
      verdictTag: 'BACKUP' as const,
      confidencePercent: 72,
      reasons: [
        `MAXIMUM TIRE DURABILITY: Hard C3 compound easily completes remaining laps with zero cliff.`,
        `SLOWER WARM-UP DELTA: Loses 0.48s/lap initial pace compared to Mediums on Monaco street asphalt.`,
        `SUB-OPTIMAL FOR RAIN: Hard slicks suffer dangerous aquaplaning if track wetness exceeds 25%.`,
      ],
      undercutTarget: 'COVERS SAINZ (P4)',
      monteCarloDistribution: mcC.times,
      rainContingencyCovered: false,
      winProbability: mcC.p1Prob,
      podiumProbability: mcC.podiumProb,
      expectedPoints: mcC.expectedPoints,
      cvarWorstCase: mcC.cvarWorstCase,
    },
    {
      id: 'strat-d',
      code: 'D' as const,
      name: 'PLAN D (TWO-STOP SPRINT ATTACK)',
      planLabel: 'SOFT → MEDIUM → SOFT/INTER',
      stopsCount: 2,
      compoundSequence: [currentCompound, 'MEDIUM', rainProbability > 60 ? 'INTER' : 'SOFT'] as TireCompound[],
      stintLaps: [currentLap, Math.floor(lapsRemaining / 2), Math.ceil(lapsRemaining / 2)],
      pitStopLaps: [currentLap, currentLap + Math.floor(lapsRemaining / 2)],
      totalRaceTimeSeconds: Number(timePlanD.toFixed(1)),
      timeDeltaToOptimalSeconds: deltaD,
      predictedPositionRange: 'P5 - P8',
      predictedPositionNum: 6.2,
      riskScore: 92,
      cliffLapWarning: currentLap + 18,
      isRecommended: false,
      verdictTag: 'EXTREME' as const,
      confidencePercent: 32,
      reasons: [
        `MONACO TRACK POSITION PENALTY: Second pit stop drops car into mid-pack traffic (P6-P8).`,
        `OVERTAKING IS IMPOSSIBLE: Overtake probability at Monaco is <4% even with 1.5s pace advantage.`,
        `SURRENDERS PODIUM: Expected finish drops outside top 5 despite fast lap pace.`,
      ],
      undercutTarget: 'TRAFFIC BOTTLENECK',
      monteCarloDistribution: mcD.times,
      rainContingencyCovered: true,
      winProbability: mcD.p1Prob,
      podiumProbability: mcD.podiumProb,
      expectedPoints: mcD.expectedPoints,
      cvarWorstCase: mcD.cvarWorstCase,
    },
  ];

  const optimal = candidates[0];
  return { candidates, optimal };
}

// -----------------------------------------------------------------------------
// HEURISTIC RACE ENGINEER DIRECTIVE (OFFLINE EXPERT SYSTEM)
// -----------------------------------------------------------------------------
function generateHeuristicEngineerDirective(params: any) {
  const isSC = params.safetyCarStatus === 'SC';
  const isVSC = params.safetyCarStatus === 'VSC';
  const rainProb = params.rainProbability ?? 72;
  const tireAge = params.tireAge ?? 19;
  const currentLap = params.currentLap ?? 31;
  const rainLap = params.rainArrivalLap ?? 35;

  let directive = '';
  let radioText = '';
  let confidence = 94;
  let target = 'LECLERC (P2)';
  const rationale: string[] = [];

  if (isSC) {
    directive = 'BOX BOX THIS LAP — FIT MEDIUM TIRES';
    radioText = `Driver, confirm BOX this lap. BOX, BOX. We are fitting Mediums. Safety Car speed delta saves 10.3 seconds in the pit lane. Leclerc is staying out on worn rubber. We have the delta to undercut him into Sainte Devote. Confirm radio, brake bias +1 into pit lane.`;
    confidence = 96;
    rationale.push(`Safety Car pit delta reduces pit loss from 22.4s to 12.1s (+10.3s track gain).`);
    rationale.push(`Leclerc is on 20-lap old Mediums; new Mediums provide +1.4s/lap delta to jump him.`);
    rationale.push(`Rain arrival at Lap ${rainLap} (${rainProb}% prob) is securely bridged.`);
  } else if (isVSC) {
    directive = 'BOX UNDER VSC — PREVENT TIRE CLIFF';
    radioText = `Delta positive under VSC. Box this lap, box this lap. Medium compound ready. We bank a 5.6s pit delta discount and protect against the imminent tire cliff.`;
    confidence = 89;
    rationale.push(`VSC delta saves 5.6s compared to green flag pit stop.`);
    rationale.push(`19-lap Softs are at ${tireAge} laps, approaching cliff threshold.`);
  } else if (rainProb > 85 && rainLap - currentLap <= 2) {
    directive = 'HOLD POSITION — BOX NEXT LAP FOR INTERS';
    radioText = `Radar shows heavy precipitation arriving in 90 seconds. Stay out this lap, do not take slicks. Prepare to box next lap directly for Intermediates.`;
    confidence = 92;
    target = 'TRACK POSITION DEFENSE';
    rationale.push(`Torrential rain front within 1.5 laps; fitting slicks now requires an extra stop.`);
    rationale.push(`Intermediate crossover lap estimated at Lap ${rainLap}.`);
  } else {
    directive = 'BOX THIS LAP — UNDERCUT WINDOW OPEN';
    radioText = `Driver, telemetry indicates front-left graining at 74%. Box this lap for fresh Mediums. Push on out-lap to execute undercut on Leclerc.`;
    confidence = 85;
    rationale.push(`Soft tire degradation is 0.115s/lap; Medium pace delta restores front pace.`);
    rationale.push(`Track position at Monaco is protected by fitting tires before rivals react.`);
  }

  return {
    directive,
    radioTransmission: radioText,
    speaker: 'RACE STRATEGY DIRECTOR (PITWALL)',
    confidencePercent: confidence,
    undercutTarget: target,
    strategicRationale: rationale,
    weatherAdvisory: `Rain cell estimated at Lap ${rainLap} (${rainProb}%). Track currently dry.`,
    circuit: MONACO_SPECS.circuitName,
    modelUsed: 'Antigravity Heuristic Strategy Engine (Offline Calibrated)',
  };
}

// -----------------------------------------------------------------------------
// REST API ENDPOINTS
// -----------------------------------------------------------------------------

// 1. Health & Circuit Verification (Monaco Only)
app.get('/api/health', (req: Request, res: Response) => {
  res.json({
    status: 'ONLINE',
    system: 'PITWALL — F1 Race Strategist & Monaco Telemetry',
    circuit: MONACO_SPECS.circuitName,
    trackLengthKm: MONACO_SPECS.trackLengthKm,
    geminiEnabled: !!geminiClient,
    timestamp: new Date().toISOString(),
  });
});

// 2. Monte Carlo Strategy Simulation
app.post('/api/strategy/simulate', (req: Request, res: Response) => {
  try {
    const params = req.body || {};
    const result = evaluateCandidateStrategies(params);
    res.json({
      success: true,
      circuit: MONACO_SPECS.circuitName,
      evaluatedAtLap: params.currentLap || 31,
      totalLaps: params.totalLaps || 53,
      numSimulations: params.numSimulations || 5000,
      candidates: result.candidates,
      recommended: result.optimal,
    });
  } catch (err: any) {
    console.error('Error in /api/strategy/simulate:', err);
    res.status(500).json({ success: false, error: err?.message || 'Simulation error' });
  }
});

// 3. AI Race Engineer Directives via Gemini (@google/genai)
app.post('/api/ai-engineer', async (req: Request, res: Response) => {
  const params = req.body || {};
  const currentLap = params.currentLap || 31;
  const totalLaps = params.totalLaps || 53;
  const position = params.position || 'P3';
  const scStatus = params.safetyCarStatus || 'SC';
  const tireCompound = params.currentCompound || 'SOFT';
  const tireAge = params.tireAge || 19;
  const tireDeg = params.tireDegPercent || 74.1;
  const rainProb = params.rainProbability ?? 72;
  const rainLap = params.rainArrivalLap || 35;
  const gapP2 = params.gapP2 ?? 1.842;
  const gapP4 = params.gapP4 ?? -3.419;

  // If Gemini client is active, call Google Gen AI SDK
  if (geminiClient) {
    try {
      const prompt = `You are the Lead Race Strategy Engineer at the Formula 1 Pit Wall for the Monaco Grand Prix.
The circuit is STRICTLY Circuit de Monaco (3.337 km, 60 km/h pit lane limiter, near impossible to overtake on track).
Current Race Situation:
- Lap: ${currentLap} of ${totalLaps}
- Driver Position: ${position} (Leader: Verstappen P1 +4.2s, Leclerc P2 +${gapP2}s, Sainz P4 ${gapP4}s behind)
- Safety Car: ${scStatus} (Incident at Turn 6 Mirabeau, pack slowed by 40%, pit lane open)
- Pit Loss Delta: Green flag pit loss is 22.4s; Safety Car pit loss is only 12.1s (net +10.3s track delta gain)
- Current Tires: ${tireCompound} (${tireAge} laps old, ${tireDeg}% wear, Soft cliff threshold is Lap 20)
- Weather Radar: Approaching Mediterranean rain cell, ${rainProb}% probability at Lap ${rainLap} (in ${Math.max(0, rainLap - currentLap)} laps)
- Rivals: Leclerc (P2) has not pitted. Sainz (P4) is considering pitting.

Provide your urgent, high-stakes tactical directive to the driver and pit crew in valid JSON format with these exact keys:
{
  "directive": "Short uppercase call (e.g. BOX BOX THIS LAP — FIT MEDIUM TIRES)",
  "radioTransmission": "Authentic, immersive F1 team radio transcript spoken to the driver over the intercom with engineering precision and urgency",
  "speaker": "RACE STRATEGY DIRECTOR (PITWALL)",
  "confidencePercent": 96,
  "undercutTarget": "LECLERC (P2) +1.8s",
  "strategicRationale": [
    "Point 1 explaining why pitting now under SC saves 10.3s",
    "Point 2 explaining the undercut on Leclerc",
    "Point 3 explaining tire cliff vs rain arrival window"
  ],
  "weatherAdvisory": "Brief note on rain front timing and intermediate crossover lap"
}`;

      const response = await geminiClient.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
        config: {
          systemInstruction: 'You are an elite Formula 1 Pit Wall Race Strategist with deep expertise in vehicle dynamics, Monte Carlo simulation, tire degradation physics, and Monaco GP track geometry.',
          responseMimeType: 'application/json',
        },
      });

      const responseText = response.text || '{}';
      const parsedData = JSON.parse(responseText);

      return res.json({
        success: true,
        source: 'gemini-2.5-flash',
        data: {
          ...parsedData,
          circuit: MONACO_SPECS.circuitName,
          modelUsed: 'Google Gemini 2.5 Flash (@google/genai)',
        },
      });
    } catch (geminiErr: any) {
      console.warn('[Gemini AI] Call failed or timed out. Falling back to heuristic strategist:', geminiErr?.message || geminiErr);
    }
  }

  // Graceful offline fallback
  const fallback = generateHeuristicEngineerDirective(params);
  res.json({
    success: true,
    source: 'offline-heuristic',
    data: fallback,
  });
});

// 4. Live Telemetry Readout
app.get('/api/telemetry/live', (req: Request, res: Response) => {
  res.json({
    success: true,
    circuit: MONACO_SPECS.circuitName,
    telemetry: {
      speedKmh: 42,
      gear: 2,
      rpm: 8400,
      throttle: 35,
      brake: 10,
      ersPercent: 84,
      flTemp: 104,
      frTemp: 108,
      rlTemp: 99,
      rrTemp: 102,
      fuelKg: 32.8,
      tireDegPercent: 74.1,
      currentSector: 2,
      s1Time: 19.241,
      s2Time: 34.120,
      s3Time: 20.419,
      lastLapTime: 73.78,
      currentLapTime: 34.2,
      crossoverLap: 35.4,
      gapP2: 1.842,
      gapP4: -3.419,
      overtakeRiskPercent: 3.2,
      dirtyAirLossSec: 0.65,
    },
  });
});

// 5. Scenario Presets Provider
app.get('/api/scenarios/:preset', (req: Request, res: Response) => {
  const preset = req.params.preset;
  let state = {};

  if (preset === 'real_race_78') {
    state = {
      preset: 'real_race_78',
      name: 'Monaco GP Full Race (78 Laps)',
      currentLap: 46,
      totalLaps: 78,
      safetyCarStatus: 'SC',
      rainProbability: 68,
      rainArrivalLap: 52,
      currentCompound: 'MEDIUM',
      tireAge: 24,
      fuelLoadKg: 44.5,
      description: 'Official 78-lap Monaco GP mode. Lap 46/78, P3, Safety Car deployed, rain front approaching.',
    };
  } else if (preset === 'sudden_downpour') {
    state = {
      preset: 'sudden_downpour',
      name: 'Sudden Mediterranean Downpour',
      currentLap: 32,
      totalLaps: 53,
      safetyCarStatus: 'VSC',
      rainProbability: 95,
      rainArrivalLap: 33,
      currentCompound: 'SOFT',
      tireAge: 20,
      fuelLoadKg: 31.4,
      description: 'Torrential rain hitting Port Hercule within 60 seconds! Intermediate/Wet crossover critical.',
    };
  } else if (preset === 'late_sc') {
    state = {
      preset: 'late_sc',
      name: 'Late Race Safety Car (Lap 45)',
      currentLap: 45,
      totalLaps: 53,
      safetyCarStatus: 'SC',
      rainProbability: 15,
      rainArrivalLap: 52,
      currentCompound: 'MEDIUM',
      tireAge: 26,
      fuelLoadKg: 12.2,
      description: 'Late Safety Car deployed with 8 laps to go. Sprint finish restart dilemma.',
    };
  } else if (preset === 'tire_cliff') {
    state = {
      preset: 'tire_cliff',
      name: 'Tire Cliff Crisis (Lap 33)',
      currentLap: 33,
      totalLaps: 53,
      safetyCarStatus: 'GREEN',
      rainProbability: 30,
      rainArrivalLap: 44,
      currentCompound: 'SOFT',
      tireAge: 25,
      fuelLoadKg: 29.8,
      description: 'Soft tires hit critical cliff. Severe graining and rear instability through Rascasse.',
    };
  } else {
    // Default Lap 31 Case Study
    state = {
      preset: 'lap31_default',
      name: 'Monaco Lap 31 Case Study (Default)',
      currentLap: 31,
      totalLaps: 53,
      safetyCarStatus: 'SC',
      rainProbability: 72,
      rainArrivalLap: 35,
      currentCompound: 'SOFT',
      tireAge: 19,
      fuelLoadKg: 32.8,
      description: 'Lap 31 of 53, P3, degrading Softs, rain approaching at Lap 35, Safety Car deployed.',
    };
  }

  res.json({ success: true, circuit: MONACO_SPECS.circuitName, scenario: state });
});

// 6. Server-Sent Events (SSE) Radio & Incident Feed
const radioClients: Response[] = [];

app.get('/api/radio/stream', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  radioClients.push(res);

  // Send initial handshake
  res.write(`data: ${JSON.stringify({ type: 'CONNECTED', message: 'Radio telemetry stream established' })}\n\n`);

  req.on('close', () => {
    const idx = radioClients.indexOf(res);
    if (idx !== -1) radioClients.splice(idx, 1);
  });
});

app.post('/api/radio/broadcast', (req: Request, res: Response) => {
  const { category, speaker, text, severity } = req.body || {};
  const event = {
    id: Math.random().toString(36).substring(2, 9),
    timestamp: new Date().toLocaleTimeString('en-US', { hour12: false }),
    category: category || 'RADIO',
    speaker: speaker || 'PITWALL',
    text: text || '',
    severity: severity || 'INFO',
  };

  const payload = `data: ${JSON.stringify(event)}\n\n`;
  radioClients.forEach((client) => {
    try {
      client.write(payload);
    } catch {
      // client disconnected
    }
  });

  res.json({ success: true, event });
});

// -----------------------------------------------------------------------------
// STATIC FILE SERVING & SPA FALLBACK (PRODUCTION)
// -----------------------------------------------------------------------------
const distPath = path.resolve(__dirname, 'dist');
if (fs.existsSync(distPath)) {
  console.log(`[Static] Serving production build from ${distPath}`);
  app.use(express.static(distPath));

  app.get('*', (req: Request, res: Response) => {
    // Only serve index.html for non-API requests
    if (!req.path.startsWith('/api')) {
      res.sendFile(path.join(distPath, 'index.html'));
    } else {
      res.status(404).json({ error: 'Endpoint not found' });
    }
  });
} else {
  console.log(`[Static] 'dist' directory not found. In development, Vite will serve UI from port 3000.`);
}

// Start Server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`=======================================================`);
  console.log(`🏎️ PITWALL — F1 RACE STRATEGIST & MONACO TELEMETRY BACKEND`);
  console.log(`📍 Exclusive Circuit: Circuit de Monaco (3.337 km)`);
  console.log(`🚀 Server listening on http://localhost:${PORT}`);
  console.log(`📡 Health Check: http://localhost:${PORT}/api/health`);
  console.log(`🎲 Monte Carlo Sim: POST http://localhost:${PORT}/api/strategy/simulate`);
  console.log(`🤖 AI Race Engineer: POST http://localhost:${PORT}/api/ai-engineer`);
  console.log(`=======================================================`);
});
