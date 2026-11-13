<script lang="ts">
  import "@anyblades/blades/content/table";
  import ChevronLeft from "~icons/lucide/chevron-left";
  import ChevronRight from "~icons/lucide/chevron-right";

  import { monthGrid, monthLabel, stepMonth } from "#lib/calendar.ts";

  import Icon from "./Icon.svelte";

  /**
   * サイドバーの月のカレンダー (denpa の `HomeCalendar` と同じ形)。
   *
   * - 一覧に行のある日は本文の字。押すとその日の見出しへ送る。行の無い日は控えた字で押せない
   * - 今日は赤い点。選んでいる日 (いま見ている行の日) は主の色の下線と太字
   * - ‹ › は行のある月と今月だけを行き来する
   */
  let {
    marks,
    today,
    pinned,
    onpick,
  }: {
    /** 日 (`YYYY-MM-DD`) ごとの行の数 */
    marks: Map<string, number>;
    /** 今日 (`YYYY-MM-DD`) */
    today: string;
    /** 選んでいる日 (無ければ null) */
    pinned: string | null;
    onpick: (day: string) => void;
  } = $props();

  // svelte-ignore state_referenced_locally
  let month = $state((pinned ?? today).slice(0, 7));
  $effect(() => {
    if (pinned !== null) month = pinned.slice(0, 7);
  });

  const months = $derived(
    [...new Set([...marks.keys(), today].map((d) => d.slice(0, 7)))]
      .filter(Boolean)
      .sort(),
  );
  const prev = $derived(stepMonth(months, month, -1));
  const next = $derived(stepMonth(months, month, 1));
  const weeks = $derived(monthGrid(month));
  const enabled = (day: string) => marks.has(day);
  const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

  function describe(day: string): string {
    const [, m, d] = day.split("-").map(Number);
    const n = marks.get(day);
    return `${m} 月 ${d} 日${day === today ? " (今日)" : ""}${n ? `・${n} 件` : "・なし"}`;
  }
</script>

<div class="cal">
  <div class="cal-head">
    <h2 class="side-label" id="calendar-month">{monthLabel(month)}</h2>
    <button
      type="button"
      class="cal-step"
      aria-label="前の月"
      disabled={prev === null}
      onclick={() => prev !== null && (month = prev)}
    >
      <Icon icon={ChevronLeft} size={1} />
    </button>
    <button
      type="button"
      class="cal-step"
      aria-label="次の月"
      disabled={next === null}
      onclick={() => next !== null && (month = next)}
    >
      <Icon icon={ChevronRight} size={1} />
    </button>
  </div>
  <table class="cal-grid" aria-labelledby="calendar-month">
    <thead>
      <tr>
        {#each WEEKDAYS as name (name)}
          <th scope="col" abbr="{name}曜日">{name}</th>
        {/each}
      </tr>
    </thead>
    <tbody>
      {#each weeks as week, w (w)}
        <tr>
          {#each week as day, d (d)}
            <td>
              {#if day !== null}
                <button
                  type="button"
                  class="cal-day num"
                  class:today={day === today}
                  class:pinned={day === pinned}
                  aria-label={describe(day)}
                  aria-current={day === today ? "date" : undefined}
                  aria-disabled={!enabled(day)}
                  onclick={() => enabled(day) && onpick(day)}
                >
                  {Number(day.slice(8))}
                </button>
              {/if}
            </td>
          {/each}
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .cal-head {
    display: flex;
    align-items: center;
  }
  .cal-head .side-label {
    flex: 1;
    margin: 0;
  }
  .cal-step {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    margin: 0;
    padding: 0;
    border: 0;
    border-radius: var(--so-radius-full);
    background: transparent;
    box-shadow: none;
    color: var(--so-fg);
    transition: background-color var(--so-duration) var(--so-ease);
  }
  .cal-step:hover:not(:disabled) {
    background: var(--so-hover-soft);
  }
  .cal-step:disabled {
    background: transparent;
    color: var(--so-muted);
  }
  .cal-grid {
    width: calc(100% - var(--so-space-3));
    margin: var(--so-space-1) 0 0 var(--so-space-3);
    border-collapse: collapse;
    table-layout: fixed;
  }
  .cal-grid :is(th, td) {
    padding: 0;
    border: 0;
    background: transparent;
    text-align: center;
  }
  .cal-grid th {
    height: 1.5rem;
    color: var(--so-muted);
    font-size: var(--so-text-2xs);
    font-weight: var(--so-weight);
  }
  .cal-day {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 2rem;
    margin: 0;
    padding: 0 0 var(--so-space-1);
    border: 0;
    border-radius: var(--so-radius);
    background: transparent;
    box-shadow: none;
    color: var(--so-fg);
    font-size: var(--so-text-sm);
    font-weight: var(--so-weight);
    transition: background-color var(--so-duration) var(--so-ease);
  }
  .cal-day[aria-disabled="true"] {
    color: var(--so-muted);
    cursor: default;
  }
  .cal-day.today::after {
    content: "";
    position: absolute;
    bottom: 0.3125rem;
    left: 50%;
    width: 0.25rem;
    height: 0.25rem;
    border-radius: 50%;
    background: var(--so-rec);
    transform: translateX(-50%);
  }
  .cal-day:not([aria-disabled="true"]):hover {
    background: var(--so-hover-soft);
  }
  .cal-day.pinned {
    color: var(--so-primary-text);
    font-weight: var(--so-weight-bold);
  }
  .cal-day.pinned::after {
    content: "";
    position: absolute;
    bottom: 0.25rem;
    left: 50%;
    width: 1rem;
    height: var(--so-mark);
    border-radius: var(--so-mark);
    background: var(--pico-primary);
    transform: translateX(-50%);
  }
</style>
