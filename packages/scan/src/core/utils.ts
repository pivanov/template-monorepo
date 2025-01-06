import { type Fiber, getType } from 'bippy';
import { ReactScanInternals } from '~core/index';
import type { AggregatedRender } from '~web/utils/outline';
import type { AggregatedChange, Render, RenderChange } from './instrumentation';

const unionSets = <T>(setA: Set<T>, setB: Set<T>): Set<T> => {
  const union = new Set(setA);
  for (const elem of setB) {
    union.add(elem);
  }
  return union;
};

export const aggregateChanges = (
  changes: Array<RenderChange>,
  prevAggregatedChange?: AggregatedChange,
) => {
  const newChange = {
    type: prevAggregatedChange?.type ?? new Set(),
    unstable: prevAggregatedChange?.unstable ?? false,
  };
  for (const change of changes) {
    newChange.type.add(change.type);
    newChange.unstable = newChange.unstable || (change.unstable ?? false);
  }

  return newChange;
};

export const joinAggregations = ({
  from,
  to,
}: {
  from: AggregatedRender;
  to: AggregatedRender;
}) => {
  to.changes.type = unionSets(to.changes.type, from.changes.type);
  to.changes.unstable = to.changes.unstable || from.changes.unstable;
  to.aggregatedCount += 1;
  to.didCommit = to.didCommit || from.didCommit;
  to.forget = to.forget || from.forget;
  to.fps = to.fps + from.fps;
  to.phase = unionSets(to.phase, from.phase);
  to.time = (to.time ?? 0) + (from.time ?? 0);

  to.unnecessary = to.unnecessary || from.unnecessary;
};

export const aggregateRender = (
  newRender: Render,
  prevAggregated: AggregatedRender,
) => {
  prevAggregated.changes = aggregateChanges(
    newRender.changes,
    prevAggregated.changes,
  );
  prevAggregated.aggregatedCount += 1;
  prevAggregated.didCommit = prevAggregated.didCommit || newRender.didCommit;
  prevAggregated.forget = prevAggregated.forget || newRender.forget;
  prevAggregated.fps = prevAggregated.fps + newRender.fps;
  prevAggregated.phase.add(newRender.phase);
  prevAggregated.time = (prevAggregated.time ?? 0) + (newRender.time ?? 0);

  prevAggregated.unnecessary =
    prevAggregated.unnecessary || newRender.unnecessary;
};

export const getLabelText = (
  groupedAggregatedRenders: Array<AggregatedRender>,
) => {
  let labelText = '';

  const componentsByCount = new Map<
    number,
    Array<{ name: string; forget: boolean; time: number }>
  >();

  for (const aggregatedRender of groupedAggregatedRenders) {
    const { forget, time, aggregatedCount, name } = aggregatedRender;
    if (!componentsByCount.has(aggregatedCount)) {
      componentsByCount.set(aggregatedCount, []);
    }
    const components = componentsByCount.get(aggregatedCount);
    if (components) {
      components.push({ name, forget, time: time ?? 0 });
    }
  }

  const sortedCounts = Array.from(componentsByCount.keys()).sort(
    (a, b) => b - a,
  );

  const parts: Array<string> = [];
  let cumulativeTime = 0;
  for (const count of sortedCounts) {
    const componentGroup = componentsByCount.get(count);
    if (!componentGroup) continue;

    const names = componentGroup
      .slice(0, 4)
      .map(({ name }) => name)
      .join(', ');
    let text = names;

    const totalTime = componentGroup.reduce((sum, { time }) => sum + time, 0);
    const hasForget = componentGroup.some(({ forget }) => forget);

    cumulativeTime += totalTime;

    if (componentGroup.length > 4) {
      text += '…';
    }

    if (count > 1) {
      text += ` ×${count}`;
    }

    if (hasForget) {
      text = `✨${text}`;
    }

    parts.push(text);
  }

  labelText = parts.join(', ');

  if (!labelText.length) return null;

  if (labelText.length > 40) {
    labelText = `${labelText.slice(0, 40)}…`;
  }

  if (cumulativeTime >= 0.01) {
    labelText += ` (${Number(cumulativeTime.toFixed(2))}ms)`;
  }

  return labelText;
};

export const updateFiberRenderData = (fiber: Fiber, renders: Array<Render>) => {
  ReactScanInternals.options.value.onRender?.(fiber, renders);
  const type = getType(fiber.type) || fiber.type;
  if (type && typeof type === 'function' && typeof type === 'object') {
    const renderData = (type.renderData || {
      count: 0,
      time: 0,
      renders: [],
    }) as RenderData;
    const firstRender = renders[0];
    renderData.count += firstRender.count;
    renderData.time += firstRender.time ?? 0;
    renderData.renders.push(firstRender);
    type.renderData = renderData;
  }
};

export interface RenderData {
  count: number;
  time: number;
  renders: Array<Render>;
  displayName: string | null;
  type: React.ComponentType<unknown> | null;
  changes?: Array<RenderChange>;
}

export function isEqual(a: unknown, b: unknown): boolean {
  return a === b || (Number.isNaN(a) && Number.isNaN(b));
}
