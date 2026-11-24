// Swedish text. Same keys as en.ts.

import type { LogFields } from "@sigill/protocol";
import type { Kind, Tie } from "../lib/server-facts.ts";
import type { Messages, Nouns, Sections } from "./en.ts";

const items: Nouns = {
  file: {
    label: "Filinnehåll",
    The: "Filen",
    the: "filen",
    it: "den",
    encrypted: "krypterad",
    data: "filinnehåll",
    key: "den del av länken som låser upp filen",
    unlocks: "den del som låser upp filen",
    seen: "den krypterade filen som passerar, med storleken avrundad uppåt så att den exakta storleken inte syns",
  },
  secret: {
    label: "Hemlighet",
    The: "Hemligheten",
    the: "hemligheten",
    it: "den",
    encrypted: "krypterad",
    data: "hemligheter",
    key: "den del av länken som låser upp hemligheten",
    unlocks: "den del som låser upp hemligheten",
    seen: "den krypterade hemligheten som passerar, vilket inte visar något om dess längd",
  },
  unknown: {
    label: "Innehåll",
    The: "Det som delas",
    the: "det som delas",
    it: "det",
    encrypted: "krypterat",
    data: "det som delas",
    key: "den del av länken som låser upp det som delas",
    unlocks: "den del som låser upp det som delas",
    seen: "de krypterade uppgifterna som passerar, med storleken avrundad uppåt så att den exakta storleken inte syns",
  },
};

// Samma fält som logFields i en.ts, inklusive `event`.
const logFields: Record<"event" | keyof LogFields, readonly [string, string]> = {
  event: [
    "vad som hände, till exempel att en länk öppnades eller en anslutning nekades",
    "För att se hur tjänsten beter sig och hitta vad som gick fel.",
  ],
  link: [
    "de 6 första tecknen i ett länk-ID",
    "Så att vi kan följa en länk genom loggen när något går fel, utan att kunna hitta själva länken.",
  ],
  links: [
    "hur många länkar en avsändare har",
    "För att se hur tjänsten används och upptäcka en avsändare med ovanligt många länkar.",
  ],
  bytes: [
    "meddelandens storlek",
    "För att upptäcka för stora eller trasiga meddelanden och dimensionera servern.",
  ],
  reason: [
    "varför en länk, en anslutning, ett mejl eller en kod nekades",
    "För att se varför anslutningar misslyckas, så att vi kan åtgärda orsaken.",
  ],
  code: ["felkoder", "För att hitta fel i webbappen eller servern."],
  path: [
    "om varje anslutning gick direkt, via vårt relä eller misslyckades",
    "För att veta hur ofta anslutningar behöver vårt relä, vilket visar hur stort det måste vara.",
  ],
  port: ["porten servern lyssnar på", "För att bekräfta att servern startade där den ska."],
};

export const sv: Messages = {
  product: "Fidant",
  tabTitles: {
    landing: "Fidant: privat filöverföring",
    send: "Skicka en fil – Fidant",
    secret: "Dela en hemlighet – Fidant",
    receive: "Ta emot – Fidant",
    privacy: "Integritet – Fidant",
    how: "Så fungerar det – Fidant",
    about: "Om Fidant – Fidant",
    terms: "Användarvillkor – Fidant",
    security: "Säkerhet – Fidant",
    technical: "Teknisk beskrivning – Fidant",
  },
  menu: {
    language: "Språk",
    theme: "Tema",
    themes: { system: "System", light: "Ljust", dark: "Mörkt" },
    label: "Huvudmeny",
    send: "Skicka en fil",
    secret: "Dela en hemlighet",
    how: "Så fungerar det",
    privacy: "Integritet",
  },
  landing: {
    title: "Skicka en fil som bara mottagaren kan öppna.",
    lede: "Fidant krypterar filen i din webbläsare innan den går till den du väljer. Den sparas aldrig, och om du inte ber oss mejla länken kan ingen på vägen, inte heller vi, läsa den.",
    cta: "Skicka en fil",
    how: "Läs hur det fungerar",
    noAccount: "Inget konto. Inget sparas.",
    linkHeading: "Hela knepet sitter i länken",
    linkId: "Länk-ID. Vår server ser det, bara för att koppla ihop de två webbläsarna.",
    linkKey: "Nyckel. Webbläsare skickar aldrig det som står efter # till någon server.",
    stepsHeading: "Så går det till",
    steps: [
      ["Välj en fil", "Den stannar på din dator. Inget laddas upp."],
      ["Lägg till vem den är till", "Varje person får en egen länk som fungerar en gång."],
      [
        "Dela länken",
        "När de öppnar den går filen från din webbläsare till deras, krypterad hela vägen.",
      ],
    ] as ReadonlyArray<readonly [string, string]>,
    neverHeading: "Vår server får aldrig",
    seesHeading: "Vår server ser bara",
    relayNote:
      "Om de två webbläsarna inte kan ansluta direkt går filen i stället via vårt relä, fortfarande krypterad. Reläet ser då båda IP-adresserna och ungefär hur stor filen är, men kan inte låsa upp den.",
    caveat: "Haken: eftersom inget sparas måste fliken vara öppen tills filen har kommit fram.",
  },
  how: {
    title: "Så fungerar det",
    lede: "Vad som händer med din fil, steg för steg. Kort sagt: den låses på din dator. Bara den som har länken kan låsa upp den. Om du ber oss mejla länken gäller det även oss.",
    sections: {
      stays: {
        heading: "Din fil stannar på din dator",
        body: [
          "Du väljer en fil i webbläsaren. Den laddas inte upp någonstans.",
          "Webbläsaren låser filen innan den lämnar din dator.",
        ],
      },
      link: {
        heading: "Du får en länk med nyckeln i",
        body: [
          "Du får en länk per person. Varje länk fungerar en gång. Du skickar den själv, till exempel via mejl eller chatt, eller ger oss mottagarens e-postadress så mejlar vi den.",
          "Nyckeln som låser upp filen är delen efter tecknet #. Webbläsare skickar aldrig den delen till oss. Därför ser vi aldrig nyckeln, om du inte ber oss mejla länken. Då ger din webbläsare den till vår server en gång, för att lägga den i mejlet.",
          "Alla som har länken kan öppna filen. En länk som vi mejlar kräver också en kod som vi mejlar till samma adress, så den fungerar för alla som kan läsa den inkorgen. Skicka varje länk bara till den som den är avsedd för.",
        ],
      },
      open: {
        heading: "De öppnar länken medan din sida är öppen",
        body: [
          "Inget sparas, så din sida måste vara öppen tills de har fått filen.",
          "Vår server hjälper de två webbläsarna att hitta varandra. Den är som en telefonist som kopplar ett samtal. Den skickar vidare några små, låsta meddelanden som den inte kan läsa, om den inte har mejlat länken och därför haft nyckeln.",
          "De ser filens namn och storlek och väljer om de vill ladda ner den.",
        ],
      },
      direct: {
        heading: "Filen går direkt till dem, låst",
        body: [
          "När nätverken tillåter det går filen direkt från din dator till deras. Den är låst hela vägen.",
          "Deras webbläsare låser upp den och kontrollerar att det är exakt den fil du skickade.",
          "Precis som i ett videosamtal kan varje enhet se den andras internetadress.",
        ],
      },
      relay: {
        heading: "Ibland går den via vårt relä",
        body: [
          "Vissa nätverk kan inte ansluta direkt till varandra. Det är vanligt på mobildata och på kontorsnätverk.",
          "Då går filen via vårt relä i Stockholm i stället, fortfarande låst.",
          "Reläet kan inte öppna filen och sparar den inte.",
          "Det ser varje enhets internetadress och ungefär hur stor filen är.",
        ],
      },
      never: {
        heading: "Det här ser vi aldrig",
        body: [
          "Inte din fil. Inte filens namn. Inte nyckeln som låser upp den, om du inte ber oss mejla länken.",
          "Det gäller både vår server och vårt relä. Reläet ser aldrig nyckeln.",
        ],
      },
    },
    more: "Vill du veta mer? På integritetssidan står exakt vad vår server ser och vad den loggar.",
    moreLink: "Läs integritetssidan",
    techLink: "Läs den tekniska beskrivningen",
  },
  insecure: {
    title: "Sidan behöver en säker anslutning",
    body: "Filer krypteras i din webbläsare, och det fungerar bara över en säker anslutning. Öppna sidan med en adress som börjar med https://.",
  },
  common: {
    techDetails: "Tekniska detaljer",
    size: "Storlek",
    type: "Typ",
    typeMissing: "Inte angiven",
    you: "Du",
    sender: "Avsändare",
  },
  connection: {
    why: "Varför?",
    more: "Mer om hur det fungerar",
    direct: {
      label: "Direkt anslutning",
      explain:
        "Filen går direkt mellan de två enheterna. Båda sidor kan se den andras internetadress, precis som i ett videosamtal.",
    },
    relay: {
      label: "Via vårt relä",
      explain:
        "De två nätverken kunde inte ansluta direkt till varandra, vilket är vanligt på mobildata och kontors-wifi. Därför går filen via vårt relä i Stockholm. Den är låst hela vägen: reläet kan inte öppna den och sparar den inte. Reläet ser båda enheternas internetadresser och ungefär hur stor filen är.",
    },
  },
  format: {
    bytes: (n: number) => `${n.toLocaleString("sv")} byte`,
    progress: (percent: string, done: string, total: string) => `${percent} · ${done} av ${total}`,
  },
  send: {
    fileHeading: "Din fil",
    recipientsHeading: "Mottagare",
    continue: "Fortsätt",
    back: "Tillbaka till filen",
    title: "Skicka en fil",
    lede: "Din fil skickas från den här webbläsaren till dem du väljer. Den är krypterad hela vägen och laddas aldrig upp eller sparas.",
    localhost:
      "Sidan är öppnad på localhost, så länkarna fungerar inte på andra datorer. Öppna i stället nätverksadressen som servern skrev ut.",
    lostServer:
      "Anslutningen till servern bröts. Försöker ansluta igen… Filer som redan är på väg kan komma fram. Ingen ny kan ansluta förrän den är tillbaka, så håll sidan öppen.",
    fromLabel: "Ditt namn",
    optional: "(valfritt)",
    fromHint: "Visas för dem du skickar till.",
    fromHintEmail:
      "Om vi mejlar en länk står ditt namn också i mejlet, markerat som inte verifierat. Vår server lägger in det där och sparar det inte.",
    allowRelay: "Tillåt vårt relä om en direkt anslutning inte går",
    fromError: {
      unsafe: "Ditt namn innehåller tecken som inte kan skickas. Ta bort dem och försök igen.",
      tooLong:
        "Ditt namn och filnamnet är för långa tillsammans. Korta ditt namn eller byt namn på filen.",
    },
    chooseFile: "Välj en fil",
    chooseOther: "Välj en annan fil",
    orDrop: "eller släpp den här",
    fileError: {
      unsafe:
        "Filnamnet innehåller tecken som inte kan skickas. Byt namn på filen och försök igen.",
      tooLong: "Filnamnet är för långt för att kunna skickas. Byt namn på filen och försök igen.",
    },
    preparing: "Gör i ordning filen…",
    readFailed: "Det gick inte att läsa filen. Välj den igen.",
    hashPending: "Inte klar än",
    locked: "Ta bort alla mottagare för att ändra ditt namn eller din fil.",
    recipientLabel: "Vem ska få den?",
    recipientPlaceholder: "Mottagarens namn",
    add: "Lägg till",
    nameError: {
      missing: "Skriv ett namn.",
      taken: "Det namnet finns redan på listan.",
    },
    emailLabel: "Mottagarens e-postadress",
    emailError: "Skriv en giltig e-postadress, till exempel namn@example.se.",
    emailNotice:
      "Fidant mejlar länken åt dig, så vår server ser länkens nyckel en gång. Nyckeln sparas inte och loggas inte. Länken, nyckeln också, ligger kvar i mottagarens inkorg, så alla som kan läsa den inkorgen skulle kunna ta emot filen.",
    fileFirst: "Välj en fil först.",
    full: (max: number) => `Du kan skicka till högst ${max} personer åt gången.`,
    oneLinkEach: "Varje person får en egen länk, som fungerar en gång.",
    keepOpen: "Ha fliken öppen tills alla har fått filen. Den skickas härifrån.",
    recipients: "Mottagare",
    status: {
      waiting: (name: string) => `Väntar på att länken till ${name} ska öppnas`,
      connecting: (name: string) => `Ansluter via länken till ${name}…`,
      offered: (name: string) => `Länken till ${name} har öppnats`,
      declined: (name: string) =>
        `Länken till ${name} öppnades och filen avböjdes. Länken fungerar fortfarande.`,
      receiving: (name: string) => `Skickar via länken till ${name}`,
      delivered: (name: string) => `Levererad via länken till ${name}`,
      failed: (name: string) =>
        `Filen kom inte fram oskadd via länken till ${name}. Länken kan öppnas igen för att försöka på nytt.`,
    },
    noRelay: (name: string) =>
      `Länken till ${name} öppnades men kunde inte ansluta direkt. Om du tillåter vårt relä kan den kanske ansluta när de försöker igen.`,
    mail: {
      sending: (to: string) => `Skickar mejl till ${to}…`,
      sent: (to: string) => `Mejl skickat till ${to}`,
      failed: (to: string) =>
        `Mejlet till ${to} skickades inte. Ta bort mottagaren och lägg till den igen för att försöka på nytt, eller lägg till den utan e-postadress och dela länken själv.`,
      limit: (to: string) =>
        `Mejlet till ${to} skickades inte: för många mejl just nu. Kopiera länken och dela den själv.`,
      verifying: (to: string) => `Kod skickad till ${to}`,
      verified: (to: string) => `Verifierad med koden som skickades till ${to}`,
      lost: (to: string) =>
        `Länken som mejlades till ${to} slutade fungera när anslutningen till vår server bröts. Ta bort mottagaren och lägg till den igen för att skicka den på nytt.`,
    },
    progressFor: (name: string) => `Förlopp för ${name}`,
    copy: "Kopiera länk",
    copyFor: (name: string) => `Kopiera länken till ${name}`,
    copyNote: {
      copied: "Kopierad",
      failed: "Det gick inte att kopiera. Markera länken nedan och kopiera den själv.",
    },
    remove: "Ta bort",
    removeFor: (name: string) => `Ta bort ${name}`,
    linkFor: (name: string) => `Länk till ${name}`,
  },
  receive: {
    connecting: "Ansluter till avsändaren…",
    verify: {
      title: "Bekräfta din e-postadress för att öppna länken",
      body: (to: string) => `Vi mejlar en kod till ${to}.`,
      send: "Skicka en kod till mig",
      sending: "Skickar en kod…",
      codeLabel: "Koden från mejlet",
      submit: "Fortsätt",
      results: {
        sent: "Koden har skickats. Titta i din e-post.",
        wait: "För tidigt för en ny kod. Försök igen om en stund.",
        limit: "För många koder för den här länken. Be avsändaren att skicka länken till dig igen.",
        failed: "Vi kunde inte skicka koden. Försök igen om en stund.",
        wrong: "Koden stämmer inte. Försök igen.",
        expired: "Koden har gått ut. Be om en ny.",
        tries: "För många felaktiga försök. Be om en ny kod.",
      },
    },
    offerTitle: (from: string) =>
      from ? `${from} vill skicka en fil till dig` : "Du har fått en fil",
    unverified: "Namnet är skrivet av avsändaren och inte verifierat.",
    download: "Ladda ner",
    decline: "Tacka nej",
    offerCaption: (from: string) =>
      `Skickas från ${from ? `datorn hos ${from}` : "avsändarens dator"} till din. Krypterad, sparas aldrig på någon server.`,
    receivingTitle: "Laddar ner…",
    progressLabel: "Förlopp för nedladdningen",
    receivingCaption: "Tar emot från avsändaren. Ha fliken öppen tills det är klart.",
    doneTitle: "Nedladdningen är klar",
    verified: "Vi har kontrollerat den: det här är exakt den fil som skickades.",
    autoDownload: "Nedladdningen bör starta av sig själv.",
    savedWhereChosen: "Den är sparad där du valde.",
    saveFile: "Spara filen",
    doneCaption: "Skickad från avsändarens dator till din. Krypterad hela vägen.",
    declinedTitle: "Du tackade nej till filen",
    declinedBody:
      "Du kan stänga fliken. Om du ändrar dig fungerar länken fortfarande medan avsändarens sida är öppen.",
    showAgain: "Visa filen igen",
    tryAgain: "Försök igen",
    whatHappened: "Vad som hände",
    encryptionLabel: "Kryptering",
    encryption:
      "AES-256-GCM, hela vägen från avsändaren till dig. Nyckeln finns i din länk och lämnar aldrig den här webbläsaren.",
    encryptionEmailed:
      "AES-256-GCM. Fidant mejlade den här länken, så vår server hade nyckeln en gång.",
    sha256Checked: "SHA-256, kontrollerad",
    problems: {
      badLink: {
        title: "Länken fungerar inte",
        body: "En del av den kanske saknas. Kontrollera att du har kopierat hela länken, eller be avsändaren att skicka den igen.",
      },
      unknown: {
        title: "Länken är inte aktiv",
        body: "Filen kommer direkt från avsändarens webbläsare, så länken fungerar bara medan avsändaren har sidan öppen. Be om en ny länk.",
      },
      unbound: {
        title: "Länken fungerar inte längre",
        body: "Be avsändaren att skicka den igen.",
      },
      used: {
        title: "Länken har redan använts",
        body: "Varje länk fungerar en gång. Om du fortfarande behöver filen kan du be avsändaren om en ny länk.",
      },
      busy: {
        title: "Länken är öppen någon annanstans",
        body: "Varje länk kan bara vara öppen på ett ställe i taget. Stäng den andra fliken och ladda om den här sidan.",
      },
      offline: {
        title: "Avsändarens sida är stängd",
        body: "Filen kommer direkt från avsändarens webbläsare, så sidan måste vara öppen. Be om en ny länk.",
      },
      offlineReceiving: {
        title: "Avsändarens sida är stängd",
        body: "Filen kommer direkt från avsändarens webbläsare, så sidan måste vara öppen. Filen kanske inte sparades. Be om en ny länk.",
      },
      lost: {
        title: "Anslutningen till avsändaren bröts",
        body: "Ingenting sparades.",
      },
      lostReceiving: {
        title: "Anslutningen till avsändaren bröts",
        body: "Filen kanske inte sparades. Försök igen för att vara säker på att du får den.",
      },
      checksum: {
        title: "Filen kom inte fram oskadd",
        body: "Den ändrades eller skadades på vägen, så den sparades inte. Försök igen, och säg till avsändaren om det fortsätter att hända.",
        detail: "SHA-256-kontrollsumman för den mottagna filen stämde inte med avsändarens.",
      },
      invalid: {
        title: "Något gick fel med överföringen",
        body: "Avsändarens webbläsare skickade data som vi inte kunde läsa, så ingenting sparades.",
        detail:
          "En del av överföringen från avsändaren gick inte att dekryptera eller följde inte överföringsformatet.",
      },
      save: {
        title: "Filen kunde inte sparas",
        body: "Kontrollera att det finns tillräckligt med utrymme på disken.",
      },
      create: {
        title: "Filen kunde inte skapas",
        body: "Försök igen, eller välj ett annat ställe att spara den på.",
      },
      connect: {
        title: "Det gick inte att ansluta till avsändarens dator",
        body: "Era två datorer kunde inte nå varandra.",
      },
      noRelay: {
        title: "Det gick inte att ansluta direkt till avsändaren",
        body: "Avsändaren tillåter inte vårt relä, och era nätverk kunde troligen inte ansluta direkt till varandra. Be avsändaren att tillåta reläet, eller prova ett annat nätverk, till exempel mobildata i din telefon.",
      },
      server: {
        title: "Det gick inte att nå servern",
        body: "Servern kopplar ihop dig med avsändaren. Kontrollera din internetanslutning.",
      },
    },
  },
  secret: {
    lede: "Klistra in ett lösenord, en API-nyckel eller en annan kort hemlighet. Den går från den här webbläsaren till dem du väljer, krypterad hela vägen, och laddas aldrig upp eller sparas.",
    label: "Din hemlighet",
    hint: (max: number) => `Högst ${max.toLocaleString("sv")} tecken.`,
    count: (length: number, max: number) =>
      `${length.toLocaleString("sv")} av ${max.toLocaleString("sv")} tecken.`,
    tooLong: "Korta hemligheten för att kunna dela den.",
    lostServer:
      "Anslutningen till servern bröts. Försöker ansluta igen… Hemligheter som redan är på väg kan komma fram. Ingen ny kan ansluta förrän den är tillbaka, så håll sidan öppen.",
    problems: {
      offline: {
        title: "Avsändarens sida är stängd",
        body: "Hemligheten kommer direkt från avsändarens webbläsare, så sidan måste vara öppen. Be om en ny länk.",
      },
      offlineReceiving: {
        title: "Avsändarens sida är stängd",
        body: "Hemligheten kommer direkt från avsändarens webbläsare, så sidan måste vara öppen. Hemligheten visades inte. Be om en ny länk.",
      },
      lost: {
        title: "Anslutningen till avsändaren bröts",
        body: "Hemligheten visades inte.",
      },
      lostReceiving: {
        title: "Anslutningen till avsändaren bröts",
        body: "Hemligheten visades inte. Försök igen för att vara säker på att du får den.",
      },
      checksum: {
        title: "Hemligheten kom inte fram oskadd",
        body: "Den ändrades eller skadades på vägen, så den visades inte. Försök igen, och säg till avsändaren om det fortsätter att hända.",
        detail: "SHA-256-kontrollsumman för den mottagna hemligheten stämde inte med avsändarens.",
      },
      invalid: {
        title: "Något gick fel med överföringen",
        body: "Avsändarens webbläsare skickade data som vi inte kunde läsa, så ingenting visades.",
        detail:
          "En del av överföringen från avsändaren gick inte att dekryptera eller följde inte överföringsformatet.",
      },
      save: {
        title: "Hemligheten kunde inte visas",
        body: "Webbläsaren kunde inte läsa hemligheten den tog emot. Be avsändaren att skicka den igen.",
      },
    },
    back: "Tillbaka till hemligheten",
    first: "Skriv eller klistra in hemligheten först.",
    locked: "Ta bort alla mottagare för att ändra ditt namn eller din hemlighet.",
    keepOpen: "Ha fliken öppen tills alla har fått hemligheten. Den skickas härifrån.",
    emailNotice:
      "Fidant mejlar länken åt dig, så vår server ser länkens nyckel en gång. Nyckeln sparas inte och loggas inte. Länken, nyckeln också, ligger kvar i mottagarens inkorg, så alla som kan läsa den inkorgen skulle kunna ta emot hemligheten.",
    status: {
      declined: (name: string) =>
        `Länken till ${name} öppnades och hemligheten avböjdes. Länken fungerar fortfarande.`,
      failed: (name: string) =>
        `Hemligheten kom inte fram oskadd via länken till ${name}. Länken kan öppnas igen för att försöka på nytt.`,
    },
    unsendable: (name: string) =>
      `Hemligheten skickades inte via länken till ${name}, eftersom dess längd skulle ha synts på den här förbindelsen. Länken fungerar fortfarande.`,
    offerTitle: (from: string) =>
      from ? `${from} har skickat en hemlighet till dig` : "Du har fått en hemlighet",
    show: "Visa",
    receivingTitle: "Öppnar hemligheten…",
    doneTitle: "Här är hemligheten",
    textLabel: "Hemligheten",
    notSaved: "Den sparas inte någonstans. Kopiera den innan du stänger fliken.",
    copy: "Kopiera hemligheten",
    copyNote: {
      copied: "Kopierad",
      failed: "Det gick inte att kopiera. Markera hemligheten och kopiera den själv.",
    },
    declinedTitle: "Du tackade nej till hemligheten",
    showAgain: "Visa hemligheten igen",
  },
  server: {
    heading: "Vad vår server har just nu",
    seesLabel: "Ser",
    holdsLabel: "Har",
    passedOnLabel: "Har skickat vidare",
    fileDataLabel: (kind: Kind) => items[kind].label,
    logsLabel: "Loggar",
    afterwardsLabel: "Efteråt",
    seesSender:
      "Din IP-adress och de vanliga uppgifterna om webbläsaren som alla webbplatser får, och samma sak för varje mottagare när de öppnar sin länk.",
    seesRecipient:
      "Din IP-adress och de vanliga uppgifterna om webbläsaren som alla webbplatser får.",
    senderHolds: ({ online, links, connected, relay, emailed, sending, mailed, kind }) => {
      if (!online) {
        return mailed
          ? "Bara antalet mejl den skickade åt dig, i förvrängd form och i upp till en timme, när den har märkt att anslutningen har stängts. Det tar upp till en minut om nätverket bröts."
          : "Ingenting, när den har märkt att anslutningen har stängts. Det tar upp till en minut om nätverket bröts.";
      }
      const choice = relay
        ? "Ditt val att tillåta vårt relä."
        : "Ditt val att inte tillåta vårt relä.";
      const counts = mailed
        ? " Antalet mejl den skickade åt dig, i förvrängd form, i upp till en timme."
        : "";
      if (links === 0) {
        return `Inga länkar ännu. ${choice}${counts}`;
      }
      const ids = links === 1 ? "ID:t för din länk" : `ID:na för dina ${links} länkar`;
      const email =
        emailed === 0
          ? ""
          : emailed === 1
            ? " För länken den mejlar: mottagarens e-postadress och koderna som skickas dit."
            : ` För de ${emailed} länkar den mejlar: mottagarnas e-postadresser och koderna som skickas dit.`;
      const key =
        sending === 0
          ? `${ids}, aldrig ${items[kind].unlocks}.${email}`
          : `${ids}.${email} Medan den skickar ett mejl också ${items[kind].key}, och ditt namn.`;
      const held = `${key} ${choice}${counts}`;
      if (connected === 0) {
        return held;
      }
      const who =
        connected === 1 ? "1 mottagare är ansluten" : `${connected} mottagare är anslutna`;
      return `${held} ${who} just nu.`;
    },
    recipientHolds: (tie: Tie, emailed: boolean, kind: Kind) =>
      (emailed
        ? {
            paired: `ID:t för din länk, din e-postadress, att den här fliken har angett rätt kod och att den här sidan är ansluten till avsändaren. Servern hade ${items[kind].unlocks} bara medan den mejlade länken till dig.`,
            unpaired:
              "Din e-postadress, som avsändaren angav för den här länken, den senaste koden den mejlade dig och om den här fliken har angett den. Bara avsändarens sida kan hålla kvar dem där.",
            closed:
              "Ingenting om den här sidan, när den har märkt att anslutningen har stängts, utom om den här fliken har angett rätt kod. Det tar upp till en minut om nätverket bröts. Bara avsändarens sida kan hålla kvar det, din länks ID och din e-postadress där.",
          }
        : {
            paired: `ID:t för din länk, aldrig ${items[kind].unlocks}, och att den här sidan är ansluten till avsändaren.`,
            unpaired:
              "Ingenting som knyter den här sidan till din länk. Bara avsändarens sida kan hålla kvar din länks ID där.",
            closed:
              "Ingenting om den här sidan, när den har märkt att anslutningen har stängts. Det tar upp till en minut om nätverket bröts. Bara avsändarens sida kan hålla kvar din länks ID där.",
          })[tie],
    passedOn: (messages: number, size: string, emailed: boolean) =>
      messages === 0
        ? "Inget ännu."
        : `${messages} ${messages === 1 ? "uppkopplingsmeddelande" : "uppkopplingsmeddelanden"} (${size}), alla krypterade så att servern inte kan läsa dem${emailed ? ", utom för en länk som den har mejlat och därför haft nyckeln till" : ""}.`,
    fileData: (kind: Kind) => `Inget. ${items[kind].The} går direkt mellan webbläsarna.`,
    fileDataRelayed: (kind: Kind) =>
      `Inget. Webbläsarna kunde inte ansluta direkt, så ${items[kind].the} går ${items[kind].encrypted} via vårt relä i stället.`,
    relaySeesLabel: "Vårt relä ser",
    relaySees: (kind: Kind) =>
      `Båda webbläsarnas IP-adresser och ${items[kind].seen}. Reläet kan inte låsa upp ${items[kind].the}.`,
    relayLogsLabel: "Vårt relä loggar",
    relayLogs: (kind: Kind) =>
      `Inget i vanliga fall. Bara när vi felsöker eller stoppar missbruk: anslutningstider, IP-adresser och hur mycket data som passerade, i högst 7 dagar. Aldrig namn, nycklar eller ${items[kind].data}.`,
    relayKeepsLabel: "Vårt relä sparar",
    relayKeeps: (kind: Kind) =>
      `Ingenting av ${items[kind].the} när ${items[kind].it} har passerat. Loggrader som sparas när vi felsöker eller stoppar missbruk raderas inom 7 dagar.`,
    senderAfterwards: (online: boolean, mailed: boolean) =>
      `${
        online
          ? "När du stänger den här fliken glömmer servern dina länkar, inom högst en minut. Loggraderna finns kvar."
          : "Dina länkar försvinner från servern inom en minut efter att anslutningen stängdes. Loggraderna finns kvar."
      }${mailed ? " Det gör också antalet mejl den skickade åt dig, i förvrängd form, i upp till en timme." : ""}`,
    afterwardsRecipient: (emailed: boolean) =>
      emailed
        ? "När den här sidan kopplas från släpper servern det den har om sidan, inom högst en minut, utom det som kodkontrollen behöver: din e-postadress och om den här fliken har angett rätt kod finns kvar tills avsändarens sida stängs, och antalet koder som skickats till din adress, i förvrängd form, i upp till en timme. Loggraderna finns kvar."
        : "När den här sidan kopplas från släpper servern det den har om sidan, inom högst en minut. Loggraderna finns kvar.",
    logs: (kind: Kind) =>
      `Vad som hände, till exempel att en länk öppnades, med ${new Intl.ListFormat("sv", {
        type: "conjunction",
      }).format(
        Object.entries(logFields)
          .filter(([field]) => field !== "event")
          .map(([, [what]]) => what),
      )}. Aldrig namn, e-postadresser, mejlade koder, nycklar, ${items[kind].data} eller IP-adresser.`,
  },
  footer: {
    label: "Webbplats",
    tagline:
      "Filer krypteras i din webbläsare och kan bara läsas av mottagaren, om du inte ber oss mejla länken.",
    about: "Om Fidant",
    terms: "Villkor",
    security: "Säkerhet",
    source: "Källkod",
    license: "Öppen källkod, MIT-licens",
  },
  preview: {
    title: "Privat filöverföring med Fidant",
    receiveTitle: "Skickat till dig med Fidant",
    receiveDescription:
      "Öppna länken för att ta emot det. Det är krypterat hela vägen, och länken fungerar bara medan avsändarens sida är öppen.",
  },
  about: {
    title: "Om Fidant",
    lede: "Fidant är ett sätt att skicka en fil till någon utan att behöva lita på någon på vägen, inte heller på oss, så länge du inte ber oss mejla länken.",
    sections: [
      {
        heading: "Vem som driver det",
        body: [
          "Fidant är ett projekt med öppen källkod och har inget företag bakom sig ännu. Det är ett konceptbevis, inte en kommersiell tjänst.",
          "Det finns inga annonser, inga konton och ingen spårning.",
        ],
      },
      {
        heading: "Kontrollera själv",
        body: [
          "All kod som kör den här webbplatsen är öppen under MIT-licensen. Allt som står på integritets- och säkerhetssidorna går att kontrollera mot den, och du kan köra en egen kopia.",
        ],
        link: ["Koden på GitHub", "https://github.com/sigill-labs/sigill"],
      },
      {
        heading: "Kontakt",
        body: [
          "Frågor, fel och idéer hör hemma i projektets ärendelista. Ärenden är offentliga, så skriv aldrig filer, länkar eller personuppgifter där. Följ säkerhetssidan om du vill rapportera ett säkerhetsproblem.",
        ],
        link: ["Skapa ett ärende", "https://github.com/sigill-labs/sigill/issues"],
      },
    ] as Sections,
  },
  terms: {
    title: "Användarvillkor",
    lede: "Kort sagt: Fidant är gratis, levereras i befintligt skick och du ansvarar för det du skickar.",
    sections: [
      {
        heading: "I befintligt skick",
        body: [
          "Fidant är ett konceptbevis som erbjuds gratis och utan garantier. Tjänsten kan vara otillgänglig, ändras eller läggas ner när som helst. Lita inte på den som enda sätt att få fram en viktig fil.",
        ],
      },
      {
        heading: "Dina filer är dina",
        body: [
          "Filerna går mellan webbläsare, krypterade hela vägen. Vi har aldrig nyckeln, om du inte ber oss mejla en länk, och vi sparar den aldrig, så vi kan inte återskapa, radera eller granska dina filer åt dig. Skicka bara filer som du har rätt att dela, och bara till dem du vill dela dem med.",
          "Använd inte Fidant till något olagligt.",
        ],
      },
      {
        heading: "Länkar",
        body: [
          "Den som har en länk kan öppna filen den leder till. En länk som vi mejlar kräver också en kod som vi skickar till samma adress. Varje länk fungerar en gång, och bara medan avsändarens sida är öppen.",
        ],
      },
      {
        heading: "Ändringar",
        body: ["Villkoren kan ändras. Varje ändring syns i projektets offentliga historik."],
        link: ["Historiken för texten", "https://github.com/sigill-labs/sigill/commits/main"],
      },
    ] as Sections,
  },
  security: {
    title: "Säkerhet",
    lede: "Hur din fil skyddas, vad Fidant inte skyddar mot och hur du berättar för oss om ett problem.",
    sections: [
      {
        heading: "Så skyddas filen",
        body: [
          "Din webbläsare krypterar filen med AES-256-GCM innan den lämnar din dator. Nyckeln finns i den del av länken som står efter #, och den skickar webbläsare aldrig till någon server. Om du ber oss mejla en länk ger din webbläsare länkens nyckel till vår server en gång, för att lägga den i mejlet, och servern sparar eller loggar den inte.",
          "Filen går direkt mellan de två webbläsarna. Om ett nätverk stoppar det går den i stället krypterad via vårt relä. Vår server skickar bara vidare några små meddelanden för att koppla upp, och de är krypterade så att servern inte kan läsa dem, utom för en länk som den har mejlat och därför haft nyckeln till.",
          "Mottagarens webbläsare kontrollerar filens SHA-256-kontrollsumma, så en fil som ändrats eller skadats på vägen sparas inte.",
        ],
        link: ["Den tekniska beskrivningen", "/technical"],
      },
      {
        heading: "Det här skyddar den inte mot",
        body: [
          "Den som får tag på en länk kan öppna filen, och en länk som vi mejlar kräver också en kod som vi skickar till samma adress. Skicka varje länk bara till den den är till, på ett sätt du litar på.",
          "En länk som vi mejlar ligger kvar i mottagarens inkorg. Den som kan läsa inkorgen kan också få koden, och därmed filen. Och eftersom vår server har haft länkens nyckel måste du lita på att vi inte läser filen på vägen. Vill du undvika båda, lämna e-postadressen tom och skicka länken själv.",
          "Avsändarens namn skrivs av avsändaren och kontrolleras inte.",
          "De två webbläsarna ser varandras IP-adress, precis som i ett videosamtal. När filen går via vårt relä ser reläet båda IP-adresserna och ungefär hur stor filen är.",
          "En dator som redan är kapad kan läsa filen innan den krypteras eller efter att den låsts upp.",
          "Fidant har ännu inte granskats av någon oberoende part.",
        ],
      },
      {
        heading: "Rapportera en sårbarhet",
        body: [
          "Rapportera säkerhetsproblem privat via GitHub, inte i ett offentligt ärende. Vi svarar där.",
        ],
        link: [
          "Rapportera privat på GitHub",
          "https://github.com/sigill-labs/sigill/security/advisories/new",
        ],
      },
    ] as Sections,
  },
  // En läsarversion av docs/how-fidant-works.md, som är källan. Ändra båda tillsammans.
  technical: {
    title: "Teknisk beskrivning",
    lede: "Hur Fidant fungerar på insidan, för dig som vill kontrollera det: nycklarna, krypteringen, hur filen färdas, vad våra servrar ser och vad Fidant inte skyddar mot. Sidan Så fungerar det berättar samma sak utan tekniska termer.",
    sections: [
      {
        heading: "Delarna",
        body: [
          "Fidant har tre delar. Webbappen körs i avsändarens och mottagarens webbläsare och sköter all kryptering. Vår server i Stockholm levererar webbappen och skickar vidare meddelanden för att koppla upp de två webbläsarna, över en WebSocket. Vårt relä på samma maskin talar om för webbläsare vilken offentlig adress de har (STUN) och för vidare krypterad trafik när två webbläsare inte når varandra direkt (TURN). Om en avsändare ber oss mejla en länk skickar vår server också mejl via en e-posttjänst.",
          "Det finns inga konton, ingen databas och ingen fillagring. Servern har det den vet bara i minnet.",
          "Allt är öppen källkod, så varje påstående på den här sidan går att kontrollera mot koden.",
        ],
        link: ["Koden på GitHub", "https://github.com/sigill-labs/sigill"],
      },
      {
        heading: "Länken",
        body: [
          "För varje mottagare skapar avsändarens webbläsare en länk av formen https://fidant.se/r/<länk-ID>#<hemlighet>. Länk-ID:t är 16 slumpmässiga byte och hemligheten 32 slumpmässiga byte, båda från webbläsarens kryptografiska slumptalsgenerator.",
          "Länk-ID:t är bara ett namn på länken: vår server använder det för att koppla ihop avsändaren med mottagaren. Hemligheten står i fragmentet, delen efter #, som webbläsare inte skickar till servrar, och webbplatsen säger åt webbläsare att inte heller skicka sidans adress vidare till andra webbplatser. Appen skickar aldrig hemligheten någonstans, om inte avsändaren ber oss mejla länken (se Mejlade länkar nedan). Utöver det tar den bara fram nycklar ur den.",
          "Varje mottagare får ett eget länk-ID och en egen hemlighet, så en mottagares länk säger ingenting om någon annans.",
        ],
      },
      {
        heading: "Nycklar",
        body: [
          "Två nycklar tas fram ur hemligheten med HKDF-SHA-256. Båda är AES-256-GCM-nycklar som webbläsaren markerar som icke-exporterbara: sidan kan använda dem men inte läsa ut dem.",
          "Signalnyckeln krypterar meddelandena för uppkopplingen. Dess salt är länk-ID:t.",
          "Filnyckeln krypterar varje ram mellan webbläsarna utom den första, INIT, som bara innehåller det slumpmässiga överförings-ID:t. Dess salt är ett slumpmässigt överförings-ID som avsändaren väljer på nytt för varje försök, så en omstartad överföring använder aldrig samma nyckel och nonce två gånger.",
        ],
      },
      {
        heading: "Så kopplas webbläsarna ihop",
        body: [
          "Avsändarens sida öppnar en WebSocket mot vår server och anmäler sina länk-ID:n. När mottagaren öppnar sin länk ansluter deras sida med länk-ID:t och ett slumpmässigt försöks-ID, nytt för varje sidladdning och varje nytt försök. Servern kopplar ihop högst en mottagarsida med en länk åt gången och meddelar båda sidor.",
          "Sedan sätter webbläsarna upp en WebRTC-anslutning. Erbjudandet, svaret och nätverkskandidaterna krypteras med signalnyckeln innan de når vår server. Varje meddelande är knutet till sin länk, sitt försök och sin riktning, så servern kan inte läsa eller ändra dem, inte skicka tillbaka ett meddelande till den sida som skickade det, inte flytta det till en annan länk och inte spela upp det i ett annat försök. Att spela upp gamla meddelanden kan som mest få ett försök att misslyckas, vilket en server ändå kan åstadkomma genom att kasta dem.",
          "Det betyder mer än integritet: meddelandena innehåller fingeravtrycken för WebRTC:s egen DTLS-kryptering. Eftersom servern inte kan ändra dem kan den inte ställa sig mellan de två webbläsarna. Allt det här bygger på att vår server inte har nyckeln. För en länk som vi mejlar har den haft nyckeln, så tills det finns kontrollord skulle den kunna läsa och ändra den länkens meddelanden och ställa sig emellan.",
          "Om anslutningen till vår server bryts försöker båda sidorna ansluta igen av sig själva. Avsändarens sida anmäler sina länkar på nytt, utom länkar som vi har mejlat: dem glömde vår server med den gamla anslutningen, så de slutar fungera och avsändarens sida säger det. En mottagare som ännu höll på att ansluta försöker igen några gånger innan den ger upp. En överföring som redan har börjat behöver inte vår server och fortsätter.",
        ],
      },
      {
        heading: "Två lager kryptering",
        body: [
          "WebRTC krypterar anslutningen mellan webbläsarna med DTLS. Fidant litar inte bara på det: varje ram efter INIT krypteras också med AES-256-GCM under filnyckeln, som bara de två webbläsarna har. För en länk som vi mejlar har vår server haft länkens hemlighet, som filnyckeln tas fram ur.",
          "Varje ram börjar med ett huvud på 10 byte med version, typ och löpnummer. Huvudet autentiseras tillsammans med ramen, och nonce byggs av riktningen och löpnumret, så de två riktningarna delar aldrig nonce. En webbläsare tar bara emot nästa löpnummer, så en ram som tappas, kastas om, upprepas eller ändras stoppar överföringen.",
        ],
      },
      {
        heading: "Överföringen, ram för ram",
        body: [
          "När avsändaren väljer filen räknar webbläsaren ut dess SHA-256-kontrollsumma.",
          "INIT: avsändaren skickar överförings-ID:t. Det är den enda ramen som inte krypteras. Om den ändras blir filnyckeln en annan, och nästa ram går inte att dekryptera.",
          "META: filens namn, storlek och typ och det namn avsändaren skrev, krypterat. Mottagaren ser dem och väljer.",
          "ACCEPT eller DECLINE: mottagarens svar, krypterat. ACCEPT visar också att mottagaren har nyckeln. Inga fildata skickas före det.",
          "CHUNK: filen i lika stora ramar, högst 48 KiB var.",
          "END: filens exakta storlek och kontrollsumman som räknades ut när filen valdes.",
          "RECEIPT: kontrollsumman som mottagaren räknade ut på det som kom fram. Avsändaren räknar filen som levererad först när den stämmer.",
        ],
      },
      {
        heading: "Kontrollen av filen",
        body: [
          "Mottagarens webbläsare räknar kontrollsumman medan filen kommer fram och kontrollerar storleken, antalet delar, utfyllnaden och kontrollsumman mot END. Filen sparas bara om allt stämmer. Varje annat slut, till exempel en ram som inte går att dekryptera eller en förbindelse som stängs för tidigt, kastar det som har skrivits.",
          "Chrome och Edge kan skriva filen direkt till en plats på disken som mottagaren väljer. Andra webbläsare samlar den i minnet och startar nedladdningen i slutet. Nedladdningen märks alltid som rena binärdata, vilken typ avsändaren än anger, så en fil kan inte köras som en webbsida på Fidants webbplats.",
          "Namn med styrtecken, radavgränsare eller Unicode-tecken som åsidosätter eller isolerar textriktning nekas, så ett namn som slutar på .exe kan inte se ut att sluta på .pdf.",
        ],
      },
      {
        heading: "Den exakta storleken döljs",
        body: [
          "Den som kan se den krypterade trafiken, till exempel nätverken på vägen eller vårt relä, ser hur stora ramarna är. Därför avrundas storleken uppåt med metoden Padmé, som lägger till högst 12 %, och sedan till hela delar. Alla ramar med fildata är lika stora, och utfyllnaden är nollor som mottagaren kontrollerar.",
          "Den exakta storleken finns bara i de krypterade META och END. META är alltid lika stor, så inte heller filnamnets längd syns.",
          "En delad hemlighet är högst 32 KiB, och varje delad hemlighet fylls ut till exakt en del. Appen ser till det: om en förbindelse bara tillåter meddelanden som är för små för en del på 32 KiB skickas ingenting över den, och avsändaren ser att hemligheten inte skickades. Med alla webbläsare vi testade i november 2026 (Chromium, Firefox och WebKit) är delen 48 KiB. Så varje delad hemlighet ser likadan ut på nätet, oavsett längd, och likadan som vilken fil som helst på upp till 48 KiB.",
        ],
      },
      {
        heading: "Att dela en hemlighet",
        body: [
          "Sidan Dela en hemlighet skickar en hemlighet som du skriver eller klistrar in på samma sätt som en fil: samma nycklar, ramar, kontroller och engångslänkar. Ingenting sparas, så avsändarens sida måste vara öppen tills varje mottagare har fått den delade hemligheten.",
          "Avsändarens webbläsare gör om den delade hemligheten till en fil som bara finns i minnet, med ett fast namn och en typ som visar att det är en delad hemlighet. Precis som för en fil finns namnet och typen bara i den krypterade META. En delad hemlighet kan ha upp till 10 000 tecken, vilket är högst 30 000 byte.",
          "Textrutan säger åt webbläsaren att stänga av stavningskontroll, autokorrigering, automatisk stor bokstav, autofyll, skrivförslag och översättning för den.",
          "Mottagarens webbläsare behandlar ett erbjudande som en delad hemlighet bara om det har exakt den typen och är högst 32 KiB. Allt annat erbjuds som en fil. För en delad hemlighet ser mottagaren namnet som avsändaren skrev men inte storleken, och väljer Visa eller Tacka nej. Efter Tacka nej fungerar länken fortfarande.",
          "Visa håller den delade hemligheten i webbläsarens minne, aldrig i en sparadialog eller en nedladdning. Först när kontrollerna mot END stämmer avkodas den och visas, som ren text med översättning avstängd. Sidan lägger in den som text och tolkar den aldrig som HTML. Den ligger inte i ett formulärfält, vars innehåll en webbläsare kan spara med sessionen. Knappen Kopiera hemligheten lägger den i urklippet.",
          "Vår server och vårt relä hanterar en delad hemlighet som vilken fil som helst. När sidan Dela en hemlighet laddas från vår server, genom att någon skriver adressen, laddar om sidan eller följer en länk, kan vår server se att någon har öppnat den. Sidan öppnar sedan en signaleringsanslutning som varje avsändarsida gör, och när man går till den inne i appen öppnas också en. Servern får aldrig den delade hemligheten eller dess längd, och en anslutning säger inte vilken sida som öppnade den, men efter en full laddning kan servern koppla anslutningen som följer från samma adress till besöket och dra slutsatsen att den som besöker sidan delar en hemlighet och med hur många länkar. En full laddning av någon annan sida kan också avslöja att besökaren delar en hemlighet. Varje avsändarsida ansluter när den visas första gången och förblir ansluten medan fliken är öppen, så två avsändaranslutningar som är öppna samtidigt från samma adress, utan någon sidladdning mellan dem, betyder troligen att besökaren har öppnat både sidan Skicka en fil och sidan Dela en hemlighet i samma flik. Efter en full laddning av sidan Skicka en fil kommer den andra anslutningen från sidan Dela en hemlighet. Sidvisningar loggas inte.",
        ],
      },
      {
        heading: "Så färdas filen",
        body: [
          "WebRTC provar de direkta vägarna först: över det lokala nätverket, eller via varje sidas offentliga adress, som webbläsaren får veta från vår STUN-tjänst. Filen går då direkt mellan webbläsarna. Avsändarens sida visar vilken väg varje förbindelse tog.",
          "Om ingen direkt väg fungerar, vilket är vanligt på mobildata och kontorsnätverk, går trafiken via vårt TURN-relä i Stockholm. Reläet för vidare krypterade paket. Det kan inte dekryptera dem och sparar dem inte.",
          "För att använda reläet behöver en webbläsare inloggningsuppgifter, som vår server skapar för varje ihopkoppling och bara ger till de två ihopkopplade sidorna. De slutar gälla efter 5 minuter. Webbläsare når reläet över UDP, eller över TLS på port 443 där ett nätverk bara släpper igenom webbtrafik. Reläet skickar bara vidare över UDP, och bara från sin egen adress. Det vägrar skicka till andra datorer på privata eller interna nätverk (med ett godtaget undantag: reläets egen server, se beslut 0007) och begränsar hur många anslutningar som går via det samtidigt.",
          "På alla vägar ser varje webbläsare den andras IP-adress, precis som i ett videosamtal.",
        ],
      },
      {
        heading: "Att neka reläet",
        body: [
          'Avsändaren kan bocka ur "Tillåt vårt relä om en direkt anslutning inte går". Vår server ger då inga inloggningsuppgifter till reläet för den sändningen, bara STUN-adressen, så en omodifierad webbläsare kan inte använda reläet. Som extra skydd avslutar avsändarens webbläsare förbindelsen om den ändå ser att den går via reläet. Fildata skickas först när mottagaren har tackat ja, så i praktiken sker det innan något av den har passerat.',
          "Gränsen: en modifierad mottagare kan ändå skicka sin del via vårt relä med uppgifter från en annan ihopkoppling, eller via vilket offentligt relä som helst. Den mottagaren har ju nyckeln ändå. Valet avgör vilken infrastruktur som bär den krypterade trafiken, inte vem som kan läsa filen.",
        ],
      },
      {
        heading: "Flera mottagare och engångslänkar",
        body: [
          "En sändning kan gå till upp till 256 personer. Var och en har en egen länk, nyckel, förbindelse och överföring.",
          "En länk räknas som använd först när mottagarens RECEIPT stämmer. Därefter nekas den. En länk som redan är öppen i en flik nekas i en annan.",
          "Fram till dess kan länken öppnas igen: efter att mottagaren tackat nej, efter en bruten förbindelse eller efter en misslyckad kontroll. Varje nytt försök har ett nytt överförings-ID och därmed en ny filnyckel.",
          "Ingenting sparas, så en länk fungerar bara medan avsändarens sida är öppen. När den stängs glömmer vår server dess länkar inom en minut.",
        ],
      },
      {
        heading: "Mejlade länkar",
        body: [
          "Den som skickar en fil eller delar en hemlighet kan ange en mottagares e-postadress. Avsändarens sida skickar då ett meddelande till vår server med länk-ID:t, adressen, länkens hemlighet, namnet avsändaren skrev och sidans språk. Det är det enda fallet där en länks hemlighet lämnar webbläsaren.",
          "Vår server väljer ett slumpmässigt värde och mejlar mottagaren länken med värdet framför länkens hemlighet: https://fidant.se/r/<länk-ID>#e.<värde>.<hemlighet>. Den gör ett försök, med en tidsgräns, och försöker aldrig igen. Den har länkens hemlighet och avsändarens namn bara tills försöket är över, och sparar eller loggar dem aldrig. Mejlet är ren text. Det visar namnet avsändaren skrev, markerat som inte verifierat, och säger ingenting om vad som skickas, inte ens om det är en fil eller en delad hemlighet.",
          "Innan mottagarens sida ansluter skickar den värdet till vår server. Bara om det stämmer visar servern en maskerad adress, till exempel a***@example.se, och mejlar en sexsiffrig kod dit när mottagaren ber om den. En kod gäller i 10 minuter, och efter 5 felaktiga försök slutar den gälla. Rätt kod ger en slumpmässig token som bara den webbläsarfliken har, och servern kopplar inte ihop någon med en mejlad länk utan en sådan. Den som bara har länk-ID:t, eller en mejlad länk som har slutat fungera, kan inte se adressen, inte få oss att skicka koder och inte ansluta.",
          "Vår server har adressen, värdet, koderna och tokens i minnet medan avsändarens sida har länken. När avsändaren tar bort mottagaren, stänger sidan eller tappar anslutningen till vår server, eller när servern startas om, försvinner allt det och den mejlade länken slutar fungera. För att begränsa missbruk räknar servern mejl i en timme under en förvrängd form av varje adress (en HMAC med en slumpmässig nyckel), aldrig under själva adressen: högst 20 mejl i timmen från en anslutning, 50 från en IP-adress och 5 till en e-postadress, och högst 5 koder per länk, med 30 sekunders mellanrum, och 10 i timmen till en adress.",
          "Haken: nyckeln står i mejlet. Vår server har haft den, vår e-posttjänst och den som läser mejlet på vägen kan se den, och den ligger kvar i mottagarens inkorg. Koden hindrar att en vidarebefordrad länk eller en e-postskanner tar emot filen eller den delade hemligheten, men inte den som kan läsa inkorgen. Och eftersom vår server har haft nyckeln skulle den kunna ställa sig mellan de två webbläsarna för den länken. Kontrollord som båda skärmarna visar, som är planerade, ska göra det möjligt att upptäcka det. Vill du undvika allt det här, lämna e-postadressen tom och skicka länken själv.",
        ],
      },
      {
        heading: "Vad vår server och vårt relä ser och sparar",
        body: [
          "Vår server ser varje sidas IP-adress och webbläsaruppgifter, länk-ID:na, avsändarens val om reläet, vilken väg avsändaren rapporterar för varje försök (direkt, STUN, relä eller misslyckad), om en länk redan har använts, när varje sida ansluter och kopplar ner samt de krypterade meddelandena för uppkopplingen och deras storlek. Den ser aldrig filen, dess namn, typ eller exakta storlek, och inte heller en delad hemlighet eller dess längd. Den ser aldrig en länks hemlighet eller nycklarna och kan inte läsa meddelandena, utom för en länk som vi mejlar: då får den länkens hemlighet en gång för att skriva mejlet, tillsammans med mottagarens e-postadress och namnet avsändaren skrev. Den har det den vet bara i minnet och glömmer en sida inom en minut efter att den kopplat ner. Undantagen är en mejlad länks adress, koder och tokens, som finns kvar tills avsändarens sida släpper länken, och antalet mejl, som finns kvar en timme.",
          "Dess loggrader har en fast lista med fält, till exempel de 6 första tecknen i ett länk-ID och om en förbindelse gick direkt. Aldrig namn, e-postadresser, koder, nycklar, filinnehåll eller IP-adresser. De raderas efter 30 dagar.",
          "Vårt relä ser båda IP-adresserna och den krypterade trafiken, alltså filens storlek bara ungefär och ingenting av en delad hemlighets längd. På port 443 vidarebefordrar ett program på samma server varje förbindelse till reläet utan att dekryptera den, och loggar ingenting. Reläet för ingen logg. Bara för att rätta ett fel eller stoppa missbruk slår vi på en, med tider för anslutningar, IP-adresser och datamängder, i högst 7 dagar.",
        ],
        link: ["Alla loggfält, på integritetssidan", "/privacy"],
      },
      {
        heading: "Själva webbplatsen",
        body: [
          "Webbplatsen levereras bara över HTTPS, och webbläsare får besked om att aldrig använda vanlig HTTP för den. Att skicka och ta emot går inte utan en säker anslutning.",
          "En Content Security Policy låter sidorna hämta kod, stilar, typsnitt och anslutningar bara från vår egen webbplats och hindrar andra webbplatser från att visa dem i en ram. Det finns inga cookies, inga skript från tredje part och ingen spårning.",
          "WebSocketen för uppkopplingen nekar anslutningar som öppnas från andra webbplatser, och gränser skyddar servern mot överbelastning: antal anslutningar totalt och per adress, meddelanden per anslutning, länkar per avsändare, storleken på varje meddelande samt mejlen och koderna som beskrivs ovan.",
        ],
      },
      {
        heading: "Det här skyddar den inte mot",
        body: [
          "Länken är nyckeln. Den som får tag på en länk kan öppna filen eller den delade hemligheten bakom den tills länken har använts. En länk som vi mejlar kräver också en kod som skickas till samma adress, så den som kan läsa den inkorgen kan öppna den. Skicka varje länk bara till den den är till, på ett sätt du litar på.",
          "För en länk som vi mejlar har vår server, vår e-posttjänst och mottagarens inkorg nyckeln, och tills det finns kontrollord skulle vår server kunna ställa sig mellan de två webbläsarna.",
          "Din webbläsare kör den kod vår server skickar. En server som skickade annan kod skulle kunna läsa filer. Koden är offentlig, men webbläsare kan ännu inte kontrollera att det de fick stämmer med den.",
          "Avsändarens namn skrivs av avsändaren och kontrolleras inte.",
          "Den andra webbläsaren ser din IP-adress. Nätverken på vägen, och vårt relä när det används, ser båda IP-adresserna, när överföringen sker och ungefär hur stor filen är. Vår server ser båda IP-adresserna, vilken mottagare som ansluter till vilken avsändare och när, och hur många mottagare en avsändare har, och för en länk som vi mejlar mottagarens e-postadress. Så den får veta vem som skickar till vem, men inte vad, om den inte ställer sig mitt i en länk som vi har mejlat.",
          "Skadlig kod på någon av datorerna kan läsa filen innan den krypteras eller efter att den dekrypterats.",
          "När mottagaren kopierar en delad hemlighet hamnar den i enhetens urklipp, där urklippshistorik, synkning av urklippet till andra enheter och andra appar kan läsa den. När en delad hemlighet väl har visats kan Fidant inte nå den: den går varken att ta tillbaka eller radera.",
          "Fidant har ännu inte granskats av någon oberoende part.",
        ],
      },
      {
        heading: "Planerat: verifierade överföringar",
        body: [
          "Inte byggt ännu. Planen: mottagaren skriver under ett kvitto med BankID innan filen går att öppna, och kvittot namnger filen. Filnyckeln delas, och vår server lämnar ut sin halva först när kvittot är underskrivet. Händelser hamnar i en granskningslogg där manipulation syns, förankrad med betrodda tidsstämplar.",
          "När det finns beskriver den här sidan det.",
        ],
        link: [
          "Designbesluten på GitHub",
          "https://github.com/sigill-labs/sigill/tree/main/docs/decisions",
        ],
      },
    ] as Sections,
  },
  privacy: {
    title: "Integritet",
    lede: "Din fil går från din webbläsare till webbläsaren hos den du skickar till, direkt när era nätverk tillåter det och annars via vårt relä. Den låses innan den lämnar din dator, och bara den som har länken kan låsa upp den. Vi får aldrig filen, dess namn eller en hemlighet som du delar, och aldrig nyckeln om du inte ber oss mejla länken.",
    howHeading: "Så går det till att skicka",
    steps: [
      [
        "Du väljer en fil och lägger till dem du vill skicka den till.",
        "Filen stannar på din dator. Ingenting laddas upp.",
      ],
      [
        "Du får en länk per person.",
        "Varje länk innehåller nyckeln som låser upp filen. Du skickar länken själv, till exempel via mejl eller chatt, eller så mejlar vi den till en adress du anger. En länk som vi mejlar kräver också en kod som vi skickar till samma adress.",
      ],
      [
        "De öppnar länken medan din sida fortfarande är öppen.",
        "Vår server hjälper de två webbläsarna att hitta varandra, som en telefonist som kopplar ett samtal.",
      ],
      ["De ser filens namn och storlek och väljer att ladda ner den, eller tackar nej.", ""],
      [
        "Filen går från din dator till deras, låst hela vägen.",
        "Den går direkt när era nätverk tillåter det, annars via vårt relä. Deras webbläsare låser upp den och kontrollerar att det är exakt den fil du skickade.",
      ],
    ],
    keepOpen:
      "Eftersom filen aldrig sparas någonstans behöver du ha sidan öppen tills alla har laddat ner den.",
    travelHeading: "Så färdas filen",
    lockedBox:
      "Tänk dig att du lämnar över en låst låda personligen. Det finns inget postkontor emellan som håller i den, och bara den som har nyckeln kan öppna den.",
    keyPart: [
      "Nyckeln är den sista delen av länken, efter tecknet ",
      ". Webbläsare skickar aldrig den delen till någon webbplats, inte heller till vår. Därför kan vi inte låsa upp din fil, ens om vi ville. Undantaget är en länk som du ber oss mejla: då ger din webbläsare länkens nyckel till vår server en gång, för att lägga den i mejlet, och vi sparar eller loggar den inte.",
    ],
    direct:
      "Eftersom de två webbläsarna ansluter direkt till varandra kan båda se den andras nätverksadress (IP-adress), precis som i ett videosamtal. Om ett nätverk blockerar det går filen i stället via vårt relä, fortfarande låst. Reläet ser då båda IP-adresserna och ungefär hur stor filen är, men kan inte låsa upp den.",
    linkWarning:
      "Alla som har länken kan öppna filen. En länk som vi mejlar kräver också en kod som vi skickar till samma adress, så alla som kan läsa den inkorgen kan öppna den. Skicka varje länk bara till den som den är avsedd för.",
    serverHeading: "Vad vår server vet",
    neverHeading: "Aldrig",
    never: [
      ["Din fil", "Varken innehållet, filnamnet, storleken eller filtypen."],
      [
        "Din hemlighet",
        "Varken hemligheten du delar från sidan Dela en hemlighet eller dess längd: varje delad hemlighet fylls ut till samma storlek innan den lämnar din webbläsare.",
      ],
      [
        "Nyckeln, om vi inte mejlar länken åt dig",
        "Den del av länken som låser upp filen eller den delade hemligheten når aldrig oss, om du inte ber oss mejla länken. Då använder vår server den en gång för att skriva mejlet, och sparar eller loggar den inte.",
      ],
      [
        "Mottagarnas namn",
        "Inte namnen du ger dem du skickar till. Ditt eget namn når oss bara om du ber oss mejla en länk: det står då i mejlet, och vi sparar det inte.",
      ],
    ],
    seesHeading: "Bara det den behöver för att koppla ihop er eller mejla en länk",
    sees: [
      [
        "Din IP-adress och uppgifter om din webbläsare",
        "Som på alla webbplatser du besöker. Vi använder dem bara för att visa dig sidan och koppla ihop er. Vår server skriver aldrig in dem i sina loggar. Vårt relä loggar inte heller något, utom medan vi åtgärdar ett fel eller stoppar missbruk (se nedan).",
      ],
      [
        "Ett länk-ID",
        "Varje länk har ett slumpmässigt ID, som ett nummer på en kölapp, så att rätt två webbläsare kan hitta varandra. Det kan inte låsa upp något. Vi glömmer det inom en minut efter att avsändarens sida har stängts, förutom de första tecknen i våra loggrader.",
      ],
      [
        "Uppkopplingsmeddelanden",
        "Några små, låsta meddelanden som hjälper de två webbläsarna att ansluta. Vi skickar dem vidare och sparar dem inte. Vi kan inte läsa dem, utom för en länk som vi har mejlat och därför haft nyckeln till.",
      ],
      [
        "Avsändarens val om reläet",
        "Om avsändaren tillåter vårt relä, så att vi bara ger mottagare tillgång till det när avsändaren gör det. Vi glömmer det inom en minut efter att avsändarens sida har stängts, och skriver aldrig in det i våra loggar.",
      ],
      [
        "Om vi mejlar en länk: adressen, länkens nyckel och ditt namn",
        "Om du ber oss mejla en länk skickar din webbläsare mottagarens e-postadress, länken med nyckeln och ditt namn till vår server. Nyckeln och ditt namn har vi bara tills mejlet har gått iväg. Adressen har vi i minnet medan din sida är öppen, så att vi kan mejla mottagaren en kod när länken öppnas. Vi har också den senaste koden och vilka flikar som har angett rätt kod. Vi loggar aldrig adressen och skriver den aldrig till disk. Vår e-posttjänst, Amazon SES, levererar mejlen, och studsar går bara dit, aldrig till en inkorg hos oss. Amazon SES har kvar ett mejl med en länk, och därmed nyckeln och ditt namn, bara tills det har levererats: om mottagarens e-postserver inte tar emot det direkt försöker Amazon SES igen i högst 15 minuter och kastar det sedan. En adress som studsar för att den inte går att leverera hamnar på en lista som Amazon SES har för alla sina kunder, i upp till 14 dagar, så att ingen skickar mer e-post till den. Den listan kan vi inte stänga av.",
      ],
      [
        "Antal mejl",
        "För att begränsa hur många mejl någon kan skicka räknar vi under en timme mejlen till varje adress och mejlen som varje IP-adress ber oss skicka. Antalet sparas under en förvrängd form av adressen (en HMAC), aldrig under själva adressen.",
      ],
    ],
    keepHeading: "Vad vi sparar",
    keep: "Vi har inga konton, ingen databas, inga cookies och ingen spårning. Förutom loggraderna nedan, en relälogg medan vi åtgärdar ett fel eller stoppar missbruk, antalet mejl ovan, som finns kvar en timme, och e-posttjänstens lista över adresser som studsat sparas ingenting när avsändarens sida har stängts, inom högst två minuter.",
    logFields,
    logRetention: "Loggraderna raderas efter 30 dagar.",
    relayLog:
      "Vårt relä, som för den låsta filen vidare när två webbläsare inte kan ansluta direkt, har ingen logg. Bara för att åtgärda ett fel eller stoppa missbruk slår vi på en. Den sparar då för varje vidarebefordrad anslutning båda IP-adresserna och portarna, när den började och slutade och hur mycket data som gick igenom. Aldrig namn, nycklar eller fildata. Vi stänger av den och raderar den inom 7 dagar.",
  },
};
