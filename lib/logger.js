const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(level = 'info') {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const ts = () => new Date().toISOString();
  const emit = (lvl, args) => {
    if (LEVELS[lvl] < threshold) return;
    console[lvl === 'debug' ? 'log' : lvl](ts(), lvl.toUpperCase(), ...args);
  };
  return {
    debug: (...args) => emit('debug', args),
    info: (...args) => emit('info', args),
    warn: (...args) => emit('warn', args),
    error: (...args) => emit('error', args),
  };
}
