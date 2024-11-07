<script setup lang="ts">
import { z } from "zod";
import type { FormErrorEvent, FormSubmitEvent } from "#ui/types";
definePageMeta({ auth: false });

const state = reactive({
  situation: undefined,
  enemyForces: undefined,
  friendlyForces: undefined,
  mission: undefined,
  commandersIntent: undefined,
  movementPlan: undefined,
  fireSupportPlan: undefined,
  credits: undefined,
});

const schema = z.object({
  situation: z.string().trim().min(1),
  enemyForces: z.string().trim().min(1),
  friendlyForces: z.string().trim().min(1),
  mission: z.string().trim().min(1),
  commandersIntent: z.string().trim().min(1),
  movementPlan: z.string().trim().min(1),
  fireSupportPlan: z.string().trim().min(1),
  credits: z.string().trim().min(1),
});

type Schema = z.infer<typeof schema>;

const form = ref();
const briefing = ref();

const cleanText = (text: string) => text.replace(/\n/g, "\n<br>\n").trim();

const onSubmit = (event: FormSubmitEvent<Schema>) => {
  // Do something with event.data
  const situation = cleanText(event.data.situation);
  const enemyForces = cleanText(event.data.enemyForces);
  const friendlyForces = cleanText(event.data.friendlyForces);
  const mission = cleanText(event.data.mission);
  const commandersIntent = cleanText(event.data.commandersIntent);
  const movementPlan = cleanText(event.data.movementPlan);
  const fireSupportPlan = cleanText(event.data.fireSupportPlan);
  const credits = cleanText(event.data.credits);

  briefing.value = `
_cre = player createDiaryRecord ["diary", ["Credits","
<br/>
Mission created by ${credits}
<br/><br/>
Using 7R Framework
<br/><br/>
Briefing made with 7R Briefing Generator (https://www.7th-ranger.com/briefing-generator)
"]];

_exe = player createDiaryRecord ["diary", ["Execution","
<font size='18'>COMMANDER'S INTENT</font>
<br/>
${commandersIntent}
<br/><br/>
<font size='18'>MOVEMENT PLAN</font>
<br/>
${movementPlan}
<br/><br/>
<font size='18'>FIRE SUPPORT PLAN</font>
<br/>
${fireSupportPlan}
"]];

_mis = player createDiaryRecord ["diary", ["Mission","
<br/>
${mission}
"]];

_sit = player createDiaryRecord ["diary", ["Situation","
<br/>
${situation}
<br/><br/>
<br/><br/>
<font size='18'>ENEMY FORCES</font>
<br/>
${enemyForces}
<br/><br/>
<font size='18'>FRIENDLY FORCES</font>
<br/>
${friendlyForces}
"]];
`;

  setTimeout(() => {
    const element = document.getElementById("copy-button");
    if (element === null) return;
    const headerOffset = 80;
    const elementPosition = element.getBoundingClientRect().top;
    const offsetPosition = elementPosition + window.scrollY - headerOffset;
    window.scrollTo({
      top: offsetPosition,
      behavior: "smooth",
    });
  }, 100);
};

const onError = (event: FormErrorEvent) => {
  const element = document.getElementById(event.errors[0].id);
  element?.focus();
  element?.scrollIntoView({ behavior: "smooth", block: "center" });
};

const copyToClipboard = () => {
  navigator.clipboard.writeText(briefing.value.trim());
  alert("Briefing copied to clipboard!");
};
</script>

<template>
  <NuxtLayout>
    <div class="flex flex-col items-center my-4">
      <Heading1>Briefing Generator</Heading1>
      <p>
        This form will generate the standardized 7R mission briefing, which can
        be copy-pasted into the "<ProseCode>briefing.sqf</ProseCode>" file.
      </p>

      <UForm
        ref="form"
        :schema="schema"
        :state="state"
        @submit="onSubmit"
        @error="onError"
        :validate-on="['blur']"
        class="mt-4 container items-center flex flex-col"
      >
        <UFormGroup
          name="situation"
          label="Situation"
          class="mt-4 lg:w-2/4 w-full"
        >
          <UTextarea
            autoresize
            resize
            :maxrows="20"
            :rows="5"
            v-model="state.situation"
            placeholder="Describe the situation leading up to this mission."
          />
        </UFormGroup>

        <UFormGroup
          name="enemyForces"
          label="Enemy Forces"
          class="mt-4 lg:w-2/4 w-full"
        >
          <UInput
            v-model="state.enemyForces"
            placeholder="Which factions are hostile to us?"
          />
        </UFormGroup>

        <UFormGroup
          name="friendlyForces"
          label="Friendly Forces"
          class="mt-4 lg:w-2/4 w-full"
        >
          <UInput
            v-model="state.friendlyForces"
            placeholder="Which factions are friendly or neutral to us?"
          />
        </UFormGroup>

        <UFormGroup name="mission" label="Mission" class="mt-4 lg:w-2/4 w-full">
          <UTextarea
            autoresize
            resize
            :maxrows="10"
            v-model="state.mission"
            placeholder="What is the mission we are going to accomplish?"
          />
        </UFormGroup>

        <UFormGroup
          name="commandersIntent"
          label="Commander's Intent"
          class="mt-4 lg:w-2/4 w-full"
        >
          <UTextarea
            autoresize
            resize
            :maxrows="10"
            v-model="state.commandersIntent"
            placeholder="Give a brief overview of how we plan to accomplish our mission."
          />
        </UFormGroup>

        <UFormGroup
          name="movementPlan"
          label="Movement Plan"
          class="mt-4 lg:w-2/4 w-full"
        >
          <UTextarea
            autoresize
            resize
            :maxrows="10"
            v-model="state.movementPlan"
            placeholder="Mention insertion method, method of transportation and reinsertion method."
          />
        </UFormGroup>

        <UFormGroup
          name="fireSupportPlan"
          label="Fire Support Plan"
          class="mt-4 lg:w-2/4 w-full"
        >
          <UTextarea
            autoresize
            resize
            :maxrows="10"
            v-model="state.fireSupportPlan"
            placeholder="What fire support is available to us? Also mention whether supply drops are available."
          />
        </UFormGroup>

        <UFormGroup name="credits" label="Credits" class="mt-4 lg:w-2/4 w-full">
          <UInput v-model="state.credits" placeholder="Your name" />
        </UFormGroup>

        <div class="mt-4">
          <PrimaryButton type="submit"> Generate Briefing </PrimaryButton>
        </div>
      </UForm>

      <div
        v-if="briefing"
        class="mt-4 lg:w-2/4 w-full items-center flex flex-col"
      >
        <HorizontalRule class="w-full" />
        <div class="mt-4">
          <PrimaryButton id="copy-button" @click="copyToClipboard">
            Copy to clipboard
          </PrimaryButton>
        </div>
        <pre id="briefing">{{ briefing }}</pre>
      </div>
    </div>
  </NuxtLayout>
</template>
