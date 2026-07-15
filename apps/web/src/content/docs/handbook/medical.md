---
title: Medical
---

## Controls

We are using a customised ACE 3 Medical System for an optimal balance between simulation and fun gameplay.

You have two different options available at all times. To treat somebody you can use ACE Interaction and interact with the injured body parts directly. Alternatively you can use ACE Interaction and open the Medical Menu (you find it under interactions). Certain actions can only be performed on certain body parts. On Self Treatment use ACE Self-Interaction.

| Interaction Menu                                                                   | Medical Menu                                                            |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| <img width="400" src="/wiki/images/MedicalInteract.png" alt="Interaction Medical"> | <img width="400" src="/wiki/images/MedicalMenu.png" alt="Medical Menu"> |
| Better for treating fewer smaller injuries and quick medication.                   | Better for treating heavily wounded.                                    |

The following settings are recommended. You can set them in your ACE3 Settings under the category "Interaction" and "Medical". Display Interactions as Lists and allow Medical Menu.

## Vitals

- **Heart Rate** - Heart rate depends on the blood level of a patient. The basic heart rate is 80. If a patient loses blood the heart rate will go up until the heart collapses and the patient will go into cardiac arrest. Once a patient is in cardiac arrest he has to be revived within 5 minutes before he becomes unrecoverable and has to be pronounced dead.
- **Pain** - Pain is caused by wounds and impairs the effectiveness of a patient.

There are a few basic vitals which highly impact the condition of a patient:

**Blood Level** - Each individual has a default blood level of 6 litres. Blood loss is defined by the haemorrhage levels. Once the blood drops below a minimum level a patient will die.

Blood Loss is defined by the haemorrhage class as outlined in the following table:

| Definition           | Volume       |
| -------------------- | ------------ |
| Default Blood Volume | 6 litres     |
| Haemorrhage 1         | < 6 litres   |
| Haemorrhage 2         | < 5 litres   |
| Haemorrhage 3         | < 4.2 litres |
| Haemorrhage 4         | < 3.6 litres |
| Fatal Blood Volume   | < 3 litres   |

## Medical States

The following graph summarises the medical states:

<img src="/wiki/images/7R_States.png" alt="7R_States.png">

**Injured State:**
The patient is wounded and has lost some blood (Haemorrhage 1 to 3) and most likely is in pain. Unless the patient suffers continuous blood loss his situation remains manageable. He may not need a medic and can effectively treat himself.

**Critical State:**
A patient is in critical state if he is unconscious. Unconsciousness may be the result of significant blood loss as well as critical damage or vitals of the patient. Critical vitals may be the result of high wound related blood loss. A critical injury is caused by significant trauma. Furthermore, an overdose from medication may put the patient into critical condition. A patient in critical condition may need medication (epinephrine) to wake up, but he may also wake up by himself if his vitals are stable. Vitals are stable if the patient has suffered acceptable blood loss (above haemorrhage class 2).

**Cardiac Arrest State:**
A patient is in cardiac arrest if his heart stopped beating. Cardiac arrest requires immediate actions to save the patient's life. A patient enters cardiac arrest after suffering heavy blood loss (haemorrhage class 4). In addition to heavy blood loss cardiac arrest may also result from damage to vital organs and large amounts of trauma suffered by the patient. In general a patient can remain 5 minutes in cardiac arrest before he is unrecoverable. Provide continuous CPR until the heart rate is successfully restored.

**Fatal State:**
Fatalities occur if a patient is not successfully revived (i.e. a heart rate is restored) while in cardiac arrest, or once a patient loses a fatal volume of blood.

## Treatments

The following sections outline treatment options for medics and regular operators.

### Diagnosis

Both medics and regular operators have various diagnosis options available which will give them insight into the patient's health condition.

- **Check Pulse:**
  - Non-Medics: Returns whether the heart rate of a patient is normal, low or high. If you do not find a pulse the patient is in cardiac arrest.
  - Medics: Returns the heart rate of a patient. The normal heart rate is 80. If you do not find a pulse the patient is in cardiac arrest.
- **Check Blood Pressure:**
  - Non-Medic: Returns whether a patient has lost blood. If the patient suffers from haemorrhage 2 or higher, it will return that the patient lost a lot of blood.
  - Medic: Returns the haemorrhage class of the patient.
- **Check Pain:**
  - Both: Returns whether a patient is in pain. If a patient is in cardiac arrest, it is not possible to diagnose pain since he is not responsive.

### Bandages & Tourniquets

There are various types of wounds. Wounds can also be small, medium or large. Each type of bandage has a different effectiveness for different types of wounds.

<img src="/wiki/images/Wounds_Graph.png" alt="Wounds_Graph.png">

- **Field Dressing** - Bandage with medium effectiveness while being prone to open.
- **Packing Bandage** - Bandage with low effectiveness with moderate likeliness to reopen.
- **Elastic Bandage** - Highly effective bandage which is highly likely to reopen.
- **Quick Clot** - Low effectiveness to close the wound while maintaining a decent ability to keep the wound closed.
- **Tourniquet** - Tourniquets allow you to immediately stop the blood loss on any of a patient's limbs. They are a temporary measure to effectively stop any bleeding. Tourniquets cause pain and do not address the wound itself. Therefore, they are only a temporary tool to stop blood loss to gain time to address the injuries with bandages.

### Medication

Medications can be utilised to treat patients and help improve their medical state. However, medications carry a risk of causing an overdose, which results in more damage to the patient than the negative effects they are designed to treat. Some medication should only be administered by medics.

| Medication  | Effect                       | Max Dose |
| ----------- | ---------------------------- | -------- |
| Morphine    | Suppresses pain              | 5        |
| Epinephrine | Wakes up unconscious patient | 8        |

### Transfusions

Transfusions allow medics to increase the blood level of a patient. Transfusions not only need time to be set up, they also require time to run through. They can only be administered by medics. Especially patients with a high level of blood loss may need transfusions to stabilise.

### Splints

Some wounds may cause lasting damage such as fractures which require additional treatment. Splints allow medics to heal fractures on the limbs of patients to restore full mobility.

### CPR

Once a patient is in cardiac arrest, it is essential to restore a heart rate. In those cases you must administer CPR. A medic should monitor whether the overall condition of a patient allows for a successful CPR.

## First Aid Procedure

In the following paragraph you learn the procedures of dealing with wounded. Always follow this procedure to ensure an appropriate handling of the situation and proper treatment for the patient. This assumes that the wounded is unconscious, otherwise he should treat himself.

**General Rule:**

- Only one person treating one wounded, everyone around provides security
- Self-Protection has absolute priority at all times
  - Wounded are a liability, do not become one yourself
- Multiple wounded
  - Ensure everyone gets stabilised to prevent fatalities
  - Treatment Priority: Medic > Leader > Soldier
  - Individual Treatment is finished when Patient is in Combat Ready State, upon which he will be sent away to fight or provide security around the Triage Station.

**Step 1: Alert:**

- Call "man down" on the Squad Net Radio
- Squad Leader additionally reports "man down" on Platoon Net Radio

**Step 2: Recover:**

- Do not treat at the Point of Injury
- Bring Patient to cover
- Use or Call for Smoke and/or Suppressive Fire
- Use appropriate method of moving patient
- Ensure that you are being covered by other Friendlies around you

There are two methods of moving an unconscious patient:

| Dragging                                                  | Carrying                                                                           |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| <img src="/wiki/images/Dragging.png" alt="Dragging">      | <img src="/wiki/images/Carrying.png" alt="Carrying">                               |
| **Pros:**<br>- Quick to begin<br>- Low-Profile            | **Pros:**<br>- Movement Speed while Carrying<br>- Looking in Direction of Movement |
| **Cons:**<br>- Slow Movement speed<br>- Walking Backwards | **Cons:**<br>- Slow to begin<br>- High-Profile                                     |

**Step 3: Stop the Bleeding:**

- Apply Tourniquet and Bandages to all wounds

**Step 4: Diagnose:**

- Diagnose for further Treatment (Check Pulse and Blood Pressure)

**Step 5: Provide Treatment:**

- Provide CPR
- Provide secondary treatments (Bandage all wounds)

**Step 6: Handover:**

- Handover patient to Medic
- Provide details on the patient and the treatments you have conducted

## Medical Procedure

<img src="/wiki/images/7R_ProcedureFullFix.png" alt="7R_ProcedureFullFix.png">

## Triage Station

A centralised location where wounded are being gathered for treatment. Usually set up in mass-casualty situations. It can be improvised out of the situation or predefined. Once available all wounded are being brought to the Triage Station for treatment while it is operational.

- **Command** - The Platoon Medic is in charge. If he is not present the first Combat Medic at the Station is in charge until the arrival of the Platoon Medic. The Medic in charge will monitor and assess treatment priorities and queue.
- **Medical Personnel** - Focuses on all medical exclusive treatments, e.g. diagnose and medicate.
- **Assistant Personnel** - Stops the bleeding of incoming Patients and maintains the stabilised state of present Patients who are waiting for Medical Personnel. Lines up patients for easier access. Assists Medical Personnel in any way possible to allow them to focus on their tasks.
- **Capacity** - One Medic and one Assistant can deal with 2-4 stabilised patients and/or 1-2 critical patients at any point.

## What happens if you die

- **Spectator** - You will join a Spectator mode in which you can spectate your fellow players.
- **Wave Respawn** - Once a certain number of players died it might trigger a reinforcement wave.
- **Reinforcements** - Form a new unit and reinsert. Report to the Acting Platoon Leader and request orders upon arrival.

## Medical Resupplies

We have a custom system to ensure quick resupplies in the field. There are resupply packages which unfold into usable medical gear when taken by a player. Some packages only unfold in the inventory of a medic.

| Icon                                                                                       | Name                   | Content                                                                        | Requirement |
| ------------------------------------------------------------------------------------------ | ---------------------- | ------------------------------------------------------------------------------ | ----------- |
| <img src="/wiki/images/gear_FirstAidKit_CA.png" width="100" alt="gear_FirstAidKit_CA.png"> | Personal Aid Kit (PAK) | 6x Field Dressing<br>4x Quick Clot<br>2x Morphine                              | None        |
| <img src="/wiki/images/band.png" width="100" alt="band.png">                               | Bandage Pack           | 3x Field Dressing<br>3x Elastic Bandage<br>3x Quick Clot<br>3x Packing Bandage | Medic       |
| <img src="/wiki/images/meds.png" width="100" alt="meds.png">                               | Medicine Pack          | 5x Morphine<br>5x Epinephrine                                                  | Medic       |
| <img src="/wiki/images/utility.png" width="100" alt="utility.png">                         | Utility Pack           | 7x Splint<br>3x Tourniquet                                                     | Medic       |
| <img src="/wiki/images/blood.png" width="100" alt="blood.png">                             | BloodIV Pack           | 2L BloodIV                                                                     | Medic       |
