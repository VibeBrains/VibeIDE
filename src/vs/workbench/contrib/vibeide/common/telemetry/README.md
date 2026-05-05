# VibeIDE Telemetry System

## Overview

The telemetry system is the foundation for all adaptive optimizations in VibeIDE. It tracks every AI interaction with zero performance overhead, enabling data-driven improvements to routing, quality, and user experience.

## Architecture

### Core Components

1. **TelemetryService** (`telemetryService.ts`)
   - Non-blocking event queue
   - Automatic batching and flushing
   - Outcome tracking for routing decisions

2. **TelemetryStorage** (`telemetryStorage.ts`)
   - Local storage with compression (gzip)
   - Automatic rotation (30-day retention)
   - Privacy-first (never sends to cloud without opt-in)

3. **TelemetryAnalytics** (`telemetryAnalytics.ts`)
   - Model performance rankings
   - Quality score computation
   - Routing pattern detection
   - Optimization suggestions

## Key Features

### Zero Performance Impact
- All telemetry operations are async and non-blocking
- Events are queued and flushed in batches
- User experience is never impacted

### Privacy-First
- All data stored locally
- Never sent to cloud without explicit user opt-in
- Automatic cleanup of old data (30 days)

### Comprehensive Tracking
- Routing decisions and outcomes
- Model performance metrics
- User acceptance/rejection rates
- Quality signals (edit distance, ratings)

## Usage

### Recording Routing Decisions

```typescript
await telemetryService.recordRoutingDecision({
  taskType: 'code',
  contextSize: 5000,
  selectedModel: { provider: 'ollama', modelName: 'codellama:7b', isLocal: true },
  routingScore: 75,
  // ... other fields
});
```

### Updating Outcomes

```typescript
await telemetryService.updateRoutingOutcome(eventId, {
  userAccepted: true,
  userModified: false,
  editDistance: 0
});
```

### Getting Analytics

```typescript
const rankings = await analytics.computeModelRankings('code');
const patterns = await analytics.detectRoutingPatterns();
const suggestions = await analytics.suggestOptimizations();
```

## Data Format

Events are stored as JSONL (one JSON object per line) and compressed with gzip:
- Filename: `telemetry-YYYY-MM-DD.jsonl.gz`
- Location: `{userDataPath}/telemetry/`
- Retention: 30 days
- Max size: 500MB

## Integration Points

1. **Router** - Records routing decisions
2. **Chat Service** - Tracks outcomes (acceptance, rejection, edits)
3. **Adaptive Router** - Uses analytics for learned adjustments
4. **Speculative Escalation** - Validates effectiveness

## Future Enhancements

- [ ] IndexedDB support for browser context
- [ ] Real-time dashboard
- [ ] Export/import functionality
- [ ] Advanced pattern detection
- [ ] Cost tracking integration

