# PITWALL — F1 Race Strategist & Monaco Telemetry

An interactive, single-page Formula 1 Pit Strategist Mission Control dashboard built for high-stakes race strategy simulation at the Circuit de Monaco.

---

## 🏎️ Demo Scenario
- **Grand Prix:** Monaco GP (53 Laps)
- **Current State:** Lap 31 of 53
- **Track Status:** Driver running P3 on 19-lap-old Softs (74% wear, approaching cliff in 2 laps)
- **Weather Threat:** Rain radar detects rain cell approaching with 72% probability at Lap 35
- **Crisis:** Safety Car just deployed for Turn 6 incident!
- **Call Required:** Should we pit now under Safety Car for Mediums to undercut Leclerc (P2), gamble and stay out for Inters, or double-stop?

---

## ⚡ Tech Stack
- **Framework:** React 19 + TypeScript + Vite
- **Styling:** Tailwind CSS v4 (Race engineer dark palette `#0B0D12`, `#12151C`, `#232834`, `#E10600`, `#00D2BE`, `#FFB800`)
- **State Management:** Zustand (Client-authoritative, zero lag)
- **Data Visualization:** Recharts (Tire degradation cliff curves & predicted position progression)
- **Vector Animations:** High-efficiency SVG requestAnimationFrame path following at 60 FPS
- **Typography:** Orbitron, Rajdhani, JetBrains Mono, Inter

---

## 🚀 Setup & Local Execution

```bash
# 1. Install dependencies
npm install

# 2. Start development server
npm run dev
```

Visit `http://localhost:3000` to interact with the mission control dashboard.

---

## 🧠 Strategy Formulas & Mathematical Models (`/src/lib/strategy.ts`)

During the hackathon demo, use these key talking points to explain the design decisions:

### 1. Deterministic Lap Time Equation
$$\text{LapTime} = T_{\text{base}} + \Delta_{\text{compound}} + (\text{Deg}_{\text{lin}} \cdot \text{Age}) + \text{CliffDeg} + (\text{Fuel} \cdot 0.032\text{s}) + \text{WeatherPenalty} + \text{PaceOffset}$$

- **Soft (C5):** $\Delta = -0.65\text{s}$ initial pace advantage, $0.115\text{s/lap}$ degradation rate, exponential cliff kicks in at Lap 20 ($\text{factor} = (\text{Age} - 20)^{1.75} \cdot 0.18$).
- **Medium (C4):** Reference compound ($\Delta = 0.00\text{s}$), $0.068\text{s/lap}$ linear degradation, stable through 34 laps.
- **Hard (C3):** $\Delta = +0.48\text{s}$ initial delta, $0.038\text{s/lap}$ degradation, linear durability up to Lap 46.
- **Intermediate:** $+3.60\text{s}$ dry track penalty; becomes fastest tire when track wetness $> 40\%$.

### 2. The Monaco Safety Car Pit Delta Advantage
- **Green Flag Pit Loss:** $\sim 22.4\text{s}$ (60 km/h pit lane limiter vs 280+ km/h on main straight).
- **Safety Car Pit Loss:** $\sim 12.1\text{s}$ (the pack on track is slowed by 40% under SC delta).
- **Net Track Delta Gain:** Pitting under the Safety Car saves $\sim 10.3\text{ seconds}$, which is greater than the $\sim 1.8\text{s}$ gap to Leclerc (P2). Pitting now executes a clean undercut without losing track position!

### 3. Monte Carlo Stochastic Simulation (200 Runs)
Every candidate strategy is evaluated over 200 stochastic race iterations:
- Gaussian jitter on pit stop execution time ($\mu = 2.3\text{s}$, $\sigma = 0.35\text{s}$, with $5\%$ tail probability for sticky wheel nut delays $> 4.5\text{s}$).
- Weather arrival variability ($\pm 1.4\text{ laps}$).
- Rival traffic bottlenecks and track position defense.

---

## ⌨️ Keyboard Shortcuts
- `SPACE`: Play / Pause telemetry animation
- `P`: Execute Strategy (Box this lap)
- `S`: Cycle Safety Car status (SC $\to$ VSC $\to$ Green)
- `R`: Toggle Rain cell probability

---

## 📁 File Structure
```
├── src/
│   ├── components/
│   │   ├── TopBar.tsx           # Race status, scenario selector, playback & speed
│   │   ├── MonacoCircuit.tsx    # 60 FPS SVG circuit, car telemetry, pit stop, rivals
│   │   ├── StrategyVerdict.tsx  # Recommendation, confidence gauge, bullet reasons, Box CTA
│   │   ├── WhatIfControls.tsx   # SC, rain, tire age, pace attack sliders
│   │   ├── TelemetryCards.tsx   # Tire deg, fuel, temps, pit delta, position, crossover
│   │   ├── StrategyTable.tsx    # Monte Carlo comparison & visual stint timeline
│   │   ├── StrategyCharts.tsx   # Recharts degradation cliff & position projection
│   │   ├── SpecsModal.tsx       # Formula documentation modal
│   │   └── RivalsModal.tsx      # Rival telemetry & radio transcripts
│   ├── lib/
│   │   └── strategy.ts          # Pure TypeScript simulation engine & Monte Carlo
│   ├── store/
│   │   └── useRaceStore.ts      # Zustand race store with scenario presets
│   ├── data/
│   │   └── race.json            # Monaco circuit coordinates, drivers, track sectors
│   ├── types.ts                 # Full TypeScript definitions
│   ├── App.tsx                  # Root responsive grid layout & keyboard bindings
│   └── index.css                # Carbon patterns, animations, telemetry typography
└── README.md
```
