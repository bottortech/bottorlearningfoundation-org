/* ============================================
   BOTTOR LEARNING FOUNDATION — Events Data
   ============================================
   Centralized event data source used by the homepage
   "Upcoming Events" section and the Events & Calendar
   page (events.html). Rendering logic lives in events.js.

   To add a new event: add an object to the array below.
   To confirm a pending event: change its `status` from
   "pending" to "confirmed" once the venue approves it.

   Fields:
     id          unique slug, no spaces
     title       event name
     category    short label, e.g. "Library Event"
     date        "YYYY-MM-DD"
     startTime   24-hour "HH:MM"
     endTime     24-hour "HH:MM"
     venue       organization / building name
     room        room name within the venue (optional)
     address     street address / city (optional)
     cost        e.g. "Free"
     audience    e.g. "Open to the Community"
     status      "pending" | "confirmed"
     description full event description
   ============================================ */

const BLF_EVENTS = [
  {
    id: "wigglewoo-mitchell-street-2026-09-26",
    title: "WiggleWoo's Word Quest: Community Literacy & Learning Experience",
    category: "Library Event",
    image: "images/WiggleWoo_WordQuest_CommunityLibraryTour_Web.png",
    date: "2026-09-26",
    startTime: "13:00",
    endTime: "15:00",
    venue: "Milwaukee Public Library — Mitchell Street Branch",
    room: "Community Room",
    address: "Milwaukee, WI",
    cost: "Free",
    audience: "Open to the Community",
    status: "pending",
    description: "Join Bottor Learning Foundation for a free, interactive literacy experience featuring WiggleWoo's Word Quest. Children and families can explore phonics, reading, and learning through interactive gameplay while learning more about the Foundation's literacy initiatives."
  },
  {
    id: "wigglewoo-center-street-2026-10-17",
    title: "WiggleWoo's Word Quest: Community Literacy & Learning Experience",
    category: "Library Event",
    image: "images/WiggleWoo_WordQuest_CommunityLibraryTour_Web.png",
    date: "2026-10-17",
    startTime: "13:00",
    endTime: "15:00",
    venue: "Milwaukee Public Library — Center Street Branch",
    room: "Community Room",
    address: "Milwaukee, WI",
    cost: "Free",
    audience: "Open to the Community",
    status: "pending",
    description: "Join Bottor Learning Foundation for a free, interactive literacy experience featuring WiggleWoo's Word Quest. Children and families can explore phonics, reading, and learning through interactive gameplay while learning more about the Foundation's literacy initiatives."
  },
  {
    id: "wigglewoo-washington-park-2026-11-21",
    title: "WiggleWoo's Word Quest: Community Literacy & Learning Experience",
    category: "Library Event",
    image: "images/WiggleWoo_WordQuest_CommunityLibraryTour_Web.png",
    date: "2026-11-21",
    startTime: "13:00",
    endTime: "15:00",
    venue: "Milwaukee Public Library — Washington Park Branch",
    room: "Finney Community Room",
    address: "Milwaukee, WI",
    cost: "Free",
    audience: "Open to the Community",
    status: "pending",
    description: "Join Bottor Learning Foundation for a free, interactive literacy experience featuring WiggleWoo's Word Quest. Children and families can explore phonics, reading, and learning through interactive gameplay while learning more about the Foundation's literacy initiatives."
  },
  {
    id: "demo-dat-discography-2026-09-05",
    title: "Demo Dat Discography: Lyrical & Literacy Hangout",
    category: "Community Event",
    date: "2026-09-05",
    startTime: "10:00",
    endTime: "15:00",
    venue: "Kuumba Juice + Coffee",
    room: "",
    address: "274 E. Keefe Ave, Milwaukee, WI 53212",
    cost: "Free",
    audience: "Open to the Community",
    status: "confirmed",
    description: "A free community hangout hosted by Vision Minds Ent and Bottor Learning Foundation, in partnership with Kuumba Juice + Coffee — play your unreleased music, tell stories and read, drop off a book for the book drive, relax with cafe food and drink, and play WiggleWoo's Word Quest, a new children's word game."
  }
];
