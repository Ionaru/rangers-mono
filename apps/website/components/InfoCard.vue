<script setup lang="ts">
import { FontAwesomeIcon } from "@fortawesome/vue-fontawesome";

defineProps<{
  icon: string;
  heading: string;
}>();
</script>
<template>
  <div
    class="flex border border-neutral-200 dark:border-neutral-700 rounded-lg p-6 text-neutral-700 dark:text-neutral-200 items-center"
  >
    <div class="text-primary p-4">
      <font-awesome-icon :icon="['fas', icon]" size="4x" fixed-width />
    </div>
    <div class="ps-6">
      <Heading4 class="text-primary !mt-0">{{heading}}</Heading4>
      <slot />
    </div>
  </div>
</template>
