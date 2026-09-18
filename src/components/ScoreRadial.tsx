import React from 'react';
import { motion } from 'motion/react';
import { cn } from '../lib/utils';

export type ScoreTier = 'elite' | 'high' | 'medium' | 'low' | 'marginal' | 'neutral';

interface ScoreRadialProps {
  score: number;
  maxScore?: number;
  size?: number;
  strokeWidth?: number;
  label?: string;
  tier?: ScoreTier;
  showArc?: boolean;
  className?: string;
  animate?: boolean;
}

const TIER_COLORS: Record<ScoreTier, { bg: string; text: string; hex: string }> = {
  elite:    { bg: 'bg-emerald-500/10', text: 'text-emerald-300', hex: '#10b981' },
  high:     { bg: 'bg-sky-500/10',    text: 'text-sky-300',    hex: '#06b6d4' },
  medium:   { bg: 'bg-amber-500/10',  text: 'text-amber-300',  hex: '#f59e0b' },
  low:      { bg: 'bg-orange-500/10', text: 'text-orange-300', hex: '#ea580c' },
  marginal: { bg: 'bg-slate-500/10',  text: 'text-slate-400',  hex: '#647486' },
  neutral:  { bg: 'bg-indigo-500/10', text: 'text-indigo-300', hex: '#4f46e5' },
};

const tierFromScore = (score: number): ScoreTier => {
  if (score >= 85) return 'elite';
  if (score >= 70) return 'high';
  if (score >= 55) return 'medium';
  if (score >= 40) return 'low';
  return 'marginal';
};

export const ScoreRadial: React.FC<ScoreRadialProps> = ({
  score,
  maxScore = 100,
  size = 100,
  strokeWidth = 6,
  label,
  tier,
  showArc = true,
  className,
  animate = true,
}) => {
  const resolvedTier = tier ?? tierFromScore(score);
  const colors = TIER_COLORS[resolvedTier];
  const pct = Math.max(0, Math.min(100, (score / maxScore) * 100));

  const center = size / 2;
  const radius = center - strokeWidth;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (pct / 100) * circumference;

  // Color interpolation: red → amber → green based on score
  const hue = (pct / 100) * 100; // 0 = red (0°), 50 = amber (60°), 100 = green (120°)
  const arcColor = `hsl(${hue * 1.2}, 90%, 45%)`;

  return (
    <div
      className={cn(
        'bsi-score-radial',
        colors.bg,
        'border',
        `border-[${colors.hex}]`,
        className,
      )}
      style={{ width: size, height: size }}
      title={`${resolvedTier} tier — score ${score.toFixed(1)}/100`}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {/* Track circle */}
        {showArc && (
          <circle
            cx={center}
            cy={center}
            r={radius}
            fill="transparent"
            stroke="rgba(255,255,255,0.04)"
            strokeWidth={strokeWidth}
          />
        )}

        {/* Progress arc */}
        {showArc && (
          <motion.circle
            cx={center}
            cy={center}
            r={radius}
            fill="transparent"
            stroke={arcColor}
            strokeWidth={strokeWidth}
            strokeDasharray={circumference}
            strokeDashoffset={circumference}
            strokeLinecap="round"
            initial={animate ? { strokeDashoffset: circumference } : undefined}
            animate={animate ? { strokeDashoffset: offset, transition: { duration: 1, ease: 'easeOut' } } : undefined}
            transform={`rotate(-90 ${center} ${center})`}
          />
        )}

        {/* Center content */}
        <text
          x={center}
          y={center - 4}
          textAnchor="middle"
          dominantBaseline="middle"
          className={cn('score-val', colors.text)}
          style={{ fontSize: size * 0.22 }}
        >
          {pct.toFixed(0)}
        </text>
        <text
          x={center}
          y={center + 10}
          textAnchor="middle"
          dominantBaseline="middle"
          className="score-label"
          style={{ fontSize: size * 0.09 }}
        >
          / {maxScore}
        </text>
      </svg>

      {label && <span className="score-label">{label}</span>}
    </div>
  );
};

ScoreRadial.displayName = 'ScoreRadial';
export default ScoreRadial;
