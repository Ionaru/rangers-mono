<script setup lang="ts">
import { Btn } from '@7th-ranger/ui';

const { data } = await useFetch('/api/greet?name=Nuxt');
</script>
<template>
  <Btn />
  <pre data-testid="api-results">{{ data }}</pre>
</template>
