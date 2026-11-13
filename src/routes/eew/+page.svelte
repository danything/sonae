<script lang="ts">
  import "@anyblades/blades/content/table";

  import { depthText, jstFull } from "#lib/format.ts";
  import { live } from "#lib/live.svelte.ts";
  import { EEW_NOTICE } from "#lib/notice.ts";

  let { data } = $props();
  // 訓練を出していないときは、SSE で来たもの (通常だけ) を重ねる
  const list = $derived(
    data.training
      ? data.history
      : [
          ...live.eews.filter(
            (e) => !data.history.some((h) => h.eventId === e.eventId),
          ),
          ...data.history.map(
            (h) => live.eews.find((e) => e.eventId === h.eventId) ?? h,
          ),
        ],
  );
</script>

<svelte:head>
  <title>緊急地震速報 - sonae</title>
</svelte:head>

<div class="stack">
  <h1>緊急地震速報</h1>
  <p class="small panel">{EEW_NOTICE}</p>
  <p class="small">
    {#if data.training}
      訓練・試験も出しています。<a href="/eew">通常のものだけにする</a>
    {:else}
      訓練・試験は隠しています。<a href="/eew?training=1">訓練・試験も出す</a>
    {/if}
  </p>
  {#if list.length === 0}
    <p class="muted">まだ受けていません。</p>
  {:else}
    <table class="small">
      <thead>
        <tr><th>発表</th><th>種類</th><th>震源・M</th><th>警報の地域</th></tr>
      </thead>
      <tbody>
        {#each list as e (e.eventId)}
          <tr>
            <td
              >{jstFull(e.issuedAt)}<br /><span class="tiny muted"
                >第 {e.serial} 報{e.final ? " (最終)" : ""}</span
              ></td
            >
            <td>
              {e.cancelled ? "取消" : e.kind === "warning" ? "警報" : "予報"}
              {#if e.status !== "normal"}<span class="tag"
                  >{e.status === "training" ? "訓練" : "試験"}</span
                >{/if}
            </td>
            <td>
              {e.hypocenter?.name ?? "—"}{e.magnitude !== undefined
                ? `・M${e.magnitude.toFixed(1)}`
                : ""}
              <br /><span class="tiny muted"
                >深さ {depthText(e.hypocenter)}{e.assumed
                  ? "・仮定震源"
                  : ""}</span
              >
            </td>
            <td>{e.warnAreas.length > 0 ? e.warnAreas.join("・") : "—"}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>
