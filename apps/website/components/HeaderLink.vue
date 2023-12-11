<script setup lang="ts">
defineProps<{
  href: string;
  name: string;
  external?: boolean;
}>();
</script>

<template>
  <li class="relative">
    <NuxtLink
      activeClass="!text-gray-900 dark:!text-gray-100"
      class="text-sm/6 font-semibold flex items-center gap-1 text-gray-500 dark:text-gray-300 hover:text-gray-700 dark:hover:text-white"
      :to="href"
    >
      {{ name }}
      <span
        v-if="external"
        class="i-heroicons-arrow-up-right-20-solid w-3 h-3 absolute top-0.5 -right-3.5 text-gray-400 dark:text-gray-500"
      ></span>
    </NuxtLink>
  </li>
</template>
