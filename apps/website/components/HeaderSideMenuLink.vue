<script setup lang="ts">
defineProps<{
  href: string;
  name: string;
  external?: boolean;
}>();
</script>

<template>
  <NuxtLink
    activeClass="!text-gray-900 dark:!text-gray-100"
    class="py-1 flex items-center gap-1.5 lg:gap-2 group text-gray-500 dark:text-gray-300 font-semibold"
    :to="href"
  >
    <span class="relative">{{ name }}</span>
  </NuxtLink>
</template>
