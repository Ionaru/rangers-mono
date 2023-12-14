<script setup lang="ts">
import { FontAwesomeIcon } from "@fortawesome/vue-fontawesome";
</script>

<template>
  <NuxtLayout>
    <ContentDoc
      class="container mx-auto lg:px-8 px-4 sm:px-6 my-4"
      :key="$route.path"
    >
      <template #not-found>
        <div class="container mx-auto lg:px-8 px-4 sm:px-6 my-4">
          <p>Could not find this page.</p>
          <NuxtLink to="/handbook">Go back to the handbook</NuxtLink>
        </div>
      </template>
    </ContentDoc>
    <nav
      class="container mx-auto lg:px-8 px-4 sm:px-6 my-4 mt-8"
      v-if="$route.path !== '/handbook'"
    >
      <NuxtLink to="/handbook">
        <FontAwesomeIcon icon="arrow-left" class="mr-2" />
        Back to the index
      </NuxtLink>
    </nav>
  </NuxtLayout>
</template>
