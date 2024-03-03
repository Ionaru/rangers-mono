<script setup lang="ts">
import { withTrailingSlash, withLeadingSlash, joinURL } from "ufo";

const props = defineProps({
  src: {
    type: String,
    default: "",
  },
  alt: {
    type: String,
    default: "",
  },
  width: {
    type: [String, Number],
    default: undefined,
  },
  height: {
    type: [String, Number],
    default: undefined,
  },
});

const refinedSrc = computed(() => {
  if (props.src?.startsWith("/") && !props.src.startsWith("//")) {
    const _base = withLeadingSlash(
      withTrailingSlash(useRuntimeConfig().app.baseURL),
    );
    if (_base !== "/" && !props.src.startsWith(_base)) {
      return joinURL(_base, props.src);
    }
  }
  return props.src;
});
</script>

<template>
  <img class="m-4" :src="refinedSrc" :alt="alt" :width="width" :height="height" />
</template>

<style lang="postcss" scoped>
img {
  &.transparent-fix {
    @apply bg-zinc-800 dark:bg-transparent m-2 p-4 rounded-2xl;
  }

  &.element-icon {
    @apply p-2 rounded-full bg-primary m-2;
  }
}
</style>
