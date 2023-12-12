<script setup lang="ts">
import { FontAwesomeIcon } from "@fortawesome/vue-fontawesome";
import type { BreadcrumbLink } from "#ui/types";

const route = useRoute();
const content = await useAsyncData("handbook", () =>
  queryContent(route.path).findOne(),
);

const baseLink = { label: "Handbook", to: "/handbook" };

const links = computed(() => {
  const links: BreadcrumbLink[] = [baseLink];
  if (content.data.value) {
    links.push({ label: content.data.value.title });
  }
  return links;
});

watch(
  () => route.params.slug,
  async () => {
    await content.refresh();
  },
);
</script>

<template>
  <NuxtLayout>
    <nav
      class="container mx-auto lg:px-8 px-4 sm:px-6 my-4"
      v-if="route.path !== '/handbook'"
    >
      <UBreadcrumb divider="/" :links="links" />
      <NuxtLink to="/handbook">
        <FontAwesomeIcon icon="arrow-left" class="mr-2" />
        Back to the index
      </NuxtLink>
    </nav>
    <ContentDoc class="container mx-auto lg:px-8 px-4 sm:px-6 my-4">
      <template #not-found>
        <div class="container mx-auto lg:px-8 px-4 sm:px-6 my-4">
          <p>Could not find this page.</p>
          <NuxtLink to="/handbook">Go back to the handbook</NuxtLink>
        </div>
      </template>
    </ContentDoc>
    <nav
      class="container mx-auto lg:px-8 px-4 sm:px-6 my-4 mt-8"
      v-if="route.path !== '/handbook'"
    >
      <NuxtLink to="/handbook">
        <FontAwesomeIcon icon="arrow-left" class="mr-2" />
        Back to the index
      </NuxtLink>
    </nav>
  </NuxtLayout>
</template>
