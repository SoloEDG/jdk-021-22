<script setup lang="ts">
import { computed } from "vue";
import type { RoundArchive } from "../../../shared/types";
import { totals, grade } from "../lib/totals";
import { DiagnosisPanel } from "../../diagnosis";

const props = defineProps<{
  game: import("../../../shared/types").Game;
  archives: RoundArchive[];
}>();
defineEmits<{ restart: [] }>();

const latest = computed(() => props.archives[props.archives.length - 1] ?? null);
</script>
<template>
  <div v-if="game.ended" class="overlay">
    <section class="result result-wide">
      <span class="eyebrow">SHIFT COMPLETE</span>
      <div class="grade">{{ grade(game) }}</div>
      <h2>午市打烊，主厨辛苦了</h2>
      <p>
        本场净收益 <b>¥{{ totals(game).net }}</b>
      </p>
      <p>完成 {{ game.served }} 单 · 离店 {{ game.missed }} 位</p>

      <DiagnosisPanel
        v-if="latest"
        :archive="latest"
        :all="archives"
      />

      <button class="restart-btn" @click="$emit('restart')">
        再开一家好餐厅 ↗
      </button>
    </section>
  </div>
</template>
