// Swedish text. Same keys as en.ts.

import type { LogFields } from "@sigill/protocol";
import type { Kind, Tie } from "../lib/server-facts.ts";
import type { Messages, Nouns, Section, Sections } from "./en.ts";

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
    notFound: "Sidan finns inte – Fidant",
  },
  notFound: {
    title: "Sidan finns inte",
    body: "Det finns ingen sida på den här adressen. Den kan ha flyttats, eller så är länken felskriven.",
    home: "Till startsidan",
  },
  noscript:
    "Krypteringen sker i din webbläsare, så Fidant behöver JavaScript. Slå på det för att skicka eller ta emot en fil.",
  openTransfer: {
    send: "En filöverföring är fortfarande öppen i den här fliken.",
    secret: "En hemlighet delas fortfarande från den här fliken.",
    receive: "En överföring till dig är fortfarande öppen i den här fliken.",
    back: "Gå tillbaka",
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
    lede: "Fidant krypterar filen i din webbläsare innan den går till den du väljer. Den sparas aldrig, och bara den som har länken kan öppna den.",
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
    serverHeading: "Vad vår server vet",
    neverHeading: "Vår server får aldrig",
    seesHeading: "Vår server ser bara",
    relayNote:
      "Om de två webbläsarna inte kan ansluta direkt och vårt relä är tillgängligt går filen i stället via reläet, fortfarande krypterad. Reläet ser då båda IP-adresserna och ungefär hur stor filen är, men kan inte låsa upp den.",
    caveat: "Haken: eftersom inget sparas måste fliken vara öppen tills filen har kommit fram.",
    tryHeading: "Prova på dig själv",
    tryBody:
      "Skicka en fil till dig själv, öppna länken på mobilen och se den komma fram. Det tar ungefär en minut.",
    tryCta: "Skicka en fil till dig själv",
    trySecret: "Eller dela en hemlighet",
  },
  how: {
    title: "Så fungerar det",
    lede: "Vad som händer med din fil, steg för steg. Kort sagt: den låses på din dator. Bara den som har länken kan låsa upp den.",
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
          "Om reläet är tillgängligt går filen då via vårt relä i Stockholm i stället, fortfarande låst.",
          "Reläet kan inte öppna filen och sparar den inte.",
          "Det ser varje enhets internetadress och ungefär hur stor filen är.",
        ],
      },
      never: {
        heading: "Det här lämnas kvar",
        body: [
          "Vi ser aldrig din fil, dess namn eller nyckeln som låser upp den, om du inte ber oss mejla länken. Vårt relä ser aldrig nyckeln alls.",
          "Vår server och vårt relä har det de ser i minnet eller i korta loggar. Spår finns också kvar i de två webbläsarna, och mottagaren har filen.",
        ],
      },
      encryption: {
        heading: "Den låses två gånger",
        body: [
          "Din webbläsare låser filen med en nyckel som kommer från länken. Utan länken kan ingen låsa upp den.",
          "Förbindelsen mellan de två webbläsarna är också låst, så filen är låst två gånger på vägen.",
        ],
      },
      transfer: {
        heading: "Den skickas i små numrerade delar",
        body: [
          "Din webbläsare skickar filen i lika stora delar, var och en låst och numrerad.",
          "Ingen del skickas förrän mottagaren har tackat ja till filen.",
        ],
      },
      verification: {
        heading: "Mottagarens webbläsare kontrollerar den",
        body: [
          "När sista delen har kommit fram kontrollerar mottagarens webbläsare att filen är exakt den du skickade.",
          "Saknas eller ändras något kastas filen. Du ser att den kommit fram först när kontrollen har gått igenom.",
        ],
      },
      masking: {
        heading: "Storleken suddas ut",
        body: [
          "Den som ser trafiken ser ungefär hur mycket som skickas, men inte filens exakta storlek.",
          "En delad hemlighet ser alltid lika stor ut, hur lång den än är.",
        ],
      },
      protection: {
        heading: "Det som skyddar dig, och det som inte gör det",
        body: [
          "Varje risk, och vad i Fidant som står emot den.",
          "Och riskerna Fidant inte kan skydda dig mot, till exempel att någon annan får tag på länken.",
        ],
      },
      tech: {
        heading: "Orden förklarade",
        body: [
          "Fidant bygger på WebRTC, tekniken webbläsare använder för videosamtal. Den här sidan förklarar den och de andra tekniska orden på de här sidorna, till exempel STUN och TURN.",
        ],
      },
    },
    more: "Vill du veta mer? På integritetssidan står exakt vad vår server ser och vad den loggar.",
    moreLink: "Läs integritetssidan",
    readMore: "Läs mer",
    steps: "Steg",
    overview: "Översikt",
    next: "Nästa",
    copyLink: "Kopiera länk till den här delen",
    copied: "Länken kopierad",
    copyFailed: "Det gick inte att kopiera länken. Kopiera den från adressfältet i stället.",
    nav: {
      stays: "Filen",
      encryption: "Kryptering",
      link: "Länken",
      open: "Uppkoppling",
      direct: "Direkt",
      relay: "Relä",
      transfer: "Överföring",
      verification: "Kontroll",
      masking: "Maskering",
      never: "Spår",
      protection: "Skydd",
      tech: "Ordlista",
    },
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
        "Filen går direkt mellan de två enheterna. Varje sida kan se den andras internetadress, precis som i ett videosamtal.",
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
    timeLeft: (duration: string) => `Ungefär ${duration} kvar`,
  },
  send: {
    continue: "Fortsätt",
    title: "Skicka en fil",
    lede: "Välj en fil och skapa sedan en länk till varje person. Din fil skickas från den här webbläsaren till dem. Den är krypterad hela vägen och laddas aldrig upp eller sparas.",
    step: (n: number) => `Steg ${n} av 2`,
    peopleHeading: "Skapa en länk till varje person",
    change: "Byt",
    fromSummary: (name: string) => `från ${name}`,
    connectionOptions: "Anslutningsalternativ",
    addEmail: "Skapa och mejla länk",
    share: "Dela",
    shareFor: (name: string) => `Dela länken till ${name}`,
    sendingBar: (delivered: number, total: number) =>
      `Skickar från den här fliken · ${delivered} av ${total} levererade · håll den öppen`,
    allDone: "Alla länkar har levererat filen. Du kan stänga fliken.",
    summary: (done: number, total: number) => `${done} av ${total} länkar har levererat filen`,
    delivered: "Levererad",
    doneTitle: "Allt levererat",
    doneOne: (name: string) => `Filen kom fram oskadd via länken till ${name}.`,
    doneMany: (n: number) => `Filen kom fram oskadd via alla ${n} länkar.`,
    closeTab: "Du kan stänga fliken.",
    sendMore: "Skicka till någon mer",
    showDetails: "Visa detaljer",
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
      unsafe:
        "Ditt namn innehåller tecken som inte kan skickas, eller tre eller fler mellanslag i rad. Ta bort dem och försök igen.",
      tooLong:
        "Ditt namn och filnamnet är för långa tillsammans. Korta ditt namn eller byt namn på filen.",
    },
    chooseFile: "Välj en fil",
    orDrop: "eller släpp den här",
    fileError: {
      unsafe:
        "Filnamnet innehåller tecken som inte kan skickas, eller tre eller fler mellanslag i rad. Byt namn på filen och försök igen.",
      tooLong: "Filnamnet är för långt för att kunna skickas. Byt namn på filen och försök igen.",
    },
    preparing: "Gör i ordning filen…",
    readFailed: "Det gick inte att läsa filen. Välj den igen.",
    hashPending: "Inte klar än",
    locked: "Ta bort alla mottagare för att ändra ditt namn eller din fil.",
    recipientLabel: "Vem ska få den?",
    recipientPlaceholder: "Mottagarens namn",
    add: "Skapa länk",
    nameError: {
      missing: "Skriv ett namn.",
      taken: "Det namnet finns redan på listan.",
    },
    emailChoice: "Mejla länken åt mig (mindre privat)",
    emailMore: "Vad det innebär att mejla en länk",
    emailLabel: "Mottagarens mejladress",
    emailError: "Skriv en giltig mejladress, till exempel namn@example.se.",
    emailNotice:
      "Vår server ser den här länkens nyckel en gång, för att skriva mejlet. Den sparar eller loggar inte nyckeln, men vår mejltjänst och den som läser mejlet på vägen kan också se nyckeln. Länken, med nyckeln, ligger kvar i mottagarens inkorg: den som kan läsa den inkorgen kan ta emot filen. Vår server skulle också kunna ställa sig mellan er för den här länken. Låt kontrollnumret vara ikryssat och jämför det med mottagaren, så ser du om servern gör det. Om du skickar länken själv slipper du allt detta.",
    check: {
      choice: "Jämför ett nummer med mottagaren innan filen skickas",
      number: "Kontrollnummer",
      ask: (name: string) => `Be ${name} läsa upp numret på sin skärm. Stämmer det?`,
      matches: "Det stämmer",
      differs: "Det skiljer sig",
      matchesFor: (name: string) => `Det stämmer för ${name}`,
      differsFor: (name: string) => `Det skiljer sig för ${name}`,
      waiting: "Du sa att det stämmer. Det skickas när mottagaren också har bekräftat.",
      differed:
        "Numren stämde inte, så inget skickades. Någon kan ha varit emellan. Länken fungerar fortfarande om du vill försöka igen.",
      expired:
        "Kontrollnumret bekräftades inte inom 5 minuter, så inget skickades. Länken fungerar fortfarande om du vill försöka igen.",
      limit: (times: number) =>
        `Kontrollen misslyckades ${times} gånger, så länken fungerar inte längre. Någon kan försöka ta sig in mellan er. Lägg till mottagaren igen för en ny länk.`,
    },
    fileFirst: "Välj en fil först.",
    full: (max: number) => `Du kan skicka till högst ${max} personer åt gången.`,
    oneLinkEach: "Varje person får en egen länk, som fungerar en gång.",
    recipients: "Mottagare",
    status: {
      waiting: (name: string) => `Väntar på att länken till ${name} ska öppnas`,
      connecting: (name: string) => `Ansluter via länken till ${name}…`,
      checking: (name: string) => `Länken till ${name} har öppnats. Jämför kontrollnumret.`,
      offered: (name: string) => `Länken till ${name} har öppnats`,
      declined: (name: string) =>
        `Länken till ${name} öppnades och filen avböjdes. Länken fungerar fortfarande.`,
      receiving: (name: string) => `Skickar via länken till ${name}`,
      delivered: (name: string) => `Levererad via länken till ${name}`,
      failed: (name: string) =>
        `Filen kom inte fram oskadd via länken till ${name}. Länken kan öppnas igen för att försöka på nytt.`,
    },
    noConnect: (name: string) =>
      `Länken till ${name} öppnades men kunde inte ansluta till din dator. Länken fungerar fortfarande om de försöker igen.`,
    noRelay: (name: string) =>
      `Länken till ${name} öppnades men kunde inte ansluta direkt. Om du tillåter vårt relä kan den kanske ansluta när de försöker igen.`,
    mail: {
      sending: (to: string) => `Skickar mejl till ${to}…`,
      sent: (to: string) => `Mejl skickat till ${to}`,
      failed: (to: string) =>
        `Mejlet till ${to} skickades inte. Ta bort mottagaren och lägg till den igen för att försöka på nytt, eller lägg till den utan mejladress och dela länken själv.`,
      limit: (to: string) =>
        `Mejlet till ${to} skickades inte: för många mejl just nu. Kopiera länken nedan och dela den själv. Det är en ny länk, eftersom vår server hade sett den första länkens hemlighet.`,
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
      title: "Bekräfta din mejladress för att öppna länken",
      body: (to: string) => `Vi mejlar en kod till ${to}.`,
      send: "Skicka en kod till mig",
      sending: "Skickar en kod…",
      codeLabel: "Koden från mejlet",
      submit: "Fortsätt",
      results: {
        sent: "Koden har skickats. Titta i din e-post.",
        wait: "Ingen ny kod än. Försök igen om en minut, eller efter en timme om det fortsätter.",
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
    memoryWarning:
      "Den här webbläsaren håller hela filen i minnet tills du sparar den, vilket kan göra fliken långsam eller få den att krascha. Chrome eller Edge sparar direkt till disk.",
    download: "Ladda ner",
    decline: "Tacka nej",
    offerCaption: (from: string) =>
      `Skickas från ${from ? `datorn hos ${from}` : "avsändarens dator"} till din. Krypterad, sparas aldrig på någon server.`,
    receivingTitle: "Laddar ner…",
    progressLabel: "Förlopp för nedladdningen",
    receivingCaption: "Tar emot från avsändaren. Ha fliken öppen tills det är klart.",
    doneTitle: "Nedladdningen är klar",
    verified: "Vi har kontrollerat den: det här är exakt den fil som skickades.",
    autoDownload: "Webbläsaren bör spara den nu. Syns den inte?",
    onceNotice: "Länken fungerar en gång, och bara medan avsändarens sida är öppen.",
    savedWhereChosen: "Den är sparad där du valde.",
    saveFile: "Spara filen",
    doneCaption: "Skickad från avsändarens dator till din. Krypterad hela vägen.",
    declinedTitle: "Du tackade nej till filen",
    declinedBody:
      "Du kan stänga fliken. Om du ändrar dig fungerar länken fortfarande medan avsändarens sida är öppen.",
    showAgain: "Visa filen igen",
    tryAgain: "Försök igen",
    check: {
      heading: "Kontrollnummer",
      read: "Läs upp numret för avsändaren.",
      matches: "Avsändaren sa att det stämmer",
      differs: "Avsändaren sa att det skiljer sig",
      waiting: "Väntar på att avsändaren också säger att det stämmer.",
      why: "Numret kommer från den här anslutningen. Om någon satt mellan dig och avsändaren skulle era skärmar visa olika nummer.",
    },
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
      differed: {
        title: "Numren stämde inte",
        body: "Så ingenting togs emot. Någon kan ha varit emellan. Försök igen för att få ett nytt nummer.",
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
    first: "Skriv eller klistra in hemligheten först.",
    locked: "Ta bort alla mottagare för att ändra ditt namn eller din hemlighet.",
    allDone: "Alla länkar har levererat hemligheten. Du kan stänga fliken.",
    summary: (done: number, total: number) =>
      `${done} av ${total} länkar har levererat hemligheten`,
    doneOne: (name: string) => `Hemligheten kom fram oskadd via länken till ${name}.`,
    doneMany: (n: number) => `Hemligheten kom fram oskadd via alla ${n} länkar.`,
    checkChoice: "Jämför ett nummer med mottagaren innan hemligheten skickas",
    emailNotice:
      "Vår server ser den här länkens nyckel en gång, för att skriva mejlet. Den sparar eller loggar inte nyckeln, men vår mejltjänst och den som läser mejlet på vägen kan också se nyckeln. Länken, med nyckeln, ligger kvar i mottagarens inkorg: den som kan läsa den inkorgen kan ta emot hemligheten. Vår server skulle också kunna ställa sig mellan er för den här länken. Låt kontrollnumret vara ikryssat och jämför det med mottagaren, så ser du om servern gör det. Om du skickar länken själv slipper du allt detta.",
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
      failed:
        "Det gick inte att kopiera. Markera hemligheten i rutan ovanför och kopiera den själv.",
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
          ? "Bara antalet mejl den skickade åt dig, i förvrängd form, i upp till en timme, när den har märkt att anslutningen har stängts. Det tar upp till en minut om nätverket bröts."
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
      `Ingen logg över trafiken i vanliga fall. Bara när vi felsöker eller stoppar missbruk: anslutningstider, IP-adresser och hur mycket data som passerade, i högst 7 dagar. Aldrig namn, nycklar eller ${items[kind].data}. Medan det förnyar sitt certifikat loggar det också adresserna som når det på port 80, aldrig webbläsarnas, i ungefär fem veckor.`,
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
        ? "När den här sidan kopplas från släpper servern det den har om sidan, inom högst en minut, utom det som kodkontrollen behöver: din e-postadress och om den här fliken har angett rätt kod finns kvar tills avsändarens sida stängs, och antalet koder som skickats till din adress och antalet koder som din IP-adress har bett om, båda i förvrängd form, i upp till en timme. Loggraderna finns kvar."
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
    tagline: "Filer krypteras i din webbläsare. Bara länken kan låsa upp dem.",
    about: "Om Fidant",
    terms: "Villkor",
    security: "Säkerhet",
    source: "Källkod",
    license: "Öppen källkod, MIT-licens",
  },
  preview: {
    receiveTitle: "Skickat till dig med Fidant",
    receiveDescription:
      "Öppna länken för att ta emot det. Det är krypterat hela vägen, och länken fungerar bara medan avsändarens sida är öppen.",
  },
  about: {
    title: "Om Fidant",
    lede: "Fidant är ett sätt att skicka en fil till någon utan att behöva lita på någon på vägen, inte heller på oss.",
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
          "Filen går direkt mellan de två webbläsarna. Om ett nätverk stoppar det och vårt relä är tillgängligt går den i stället krypterad via reläet. Vår server skickar bara vidare några små meddelanden för att koppla upp, och de är krypterade så att servern inte kan läsa dem, utom för en länk som den har mejlat och därför haft nyckeln till.",
          "Mottagarens webbläsare kontrollerar filens SHA-256-kontrollsumma, så en fil som ändrats eller skadats på vägen sparas inte.",
        ],
        link: ["Så fungerar det, steg för steg", "/how"],
      },
      {
        heading: "Det här skyddar den inte mot",
        body: [
          "Den som får tag på en länk kan öppna filen, och en länk som vi mejlar kräver också en kod som vi skickar till samma adress. Skicka varje länk bara till den den är till, på ett sätt du litar på.",
          "En länk som vi mejlar ligger kvar i mottagarens inkorg. Den som kan läsa inkorgen kan också få koden, och därmed filen. Och eftersom vår server har haft länkens nyckel måste du lita på att vi inte läser filen på vägen, om du inte låter kontrollnumret vara på och jämför det med mottagaren. Vill du undvika båda, låt ”Mejla länken åt mig” vara urkryssad och skicka länken själv.",
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
    sections: {
      parts: {
        heading: "Delarna",
        body: [
          "Fidant har tre delar. Webbappen körs i avsändarens och mottagarens webbläsare och sköter all kryptering. Vår server i Stockholm levererar webbappen och skickar vidare meddelanden för att koppla upp de två webbläsarna, över en WebSocket. Vårt relä, på en egen maskin i Stockholm, talar om för webbläsare vilken offentlig adress de har (STUN). Om avsändaren tillåter det och det är tillgängligt skickar reläet också vidare krypterad trafik när två webbläsare inte har nått varandra direkt 3 sekunder efter att mottagaren har svarat (TURN). Om en avsändare ber oss mejla en länk skickar vår server också mejl via en e-posttjänst.",
          "Det finns inga konton, ingen fillagring och ingen databas över personer eller överföringar. Servern har det den vet om sidor och överföringar bara i minnet. På disk har servern egna hemligheter, bland dem den som reläets hemlighet kommer från, och reläet har sin nuvarande och sin förra hemlighet i en liten databasfil.",
          "Allt är öppen källkod, så varje påstående på den här sidan går att kontrollera mot koden.",
        ],
        link: ["Koden på GitHub", "https://github.com/sigill-labs/sigill"],
      },
      link: {
        heading: "Länken",
        body: [
          "För varje mottagare skapar avsändarens webbläsare en länk av formen https://fidant.se/r/<länk-ID>#<hemlighet>. Länk-ID:t är 16 slumpmässiga byte och hemligheten 32 slumpmässiga byte, båda från webbläsarens kryptografiska slumptalsgenerator.",
          'Länk-ID:t är bara ett namn på länken: vår server använder det för att koppla ihop avsändaren med mottagaren. Hemligheten står i fragmentet, delen efter #, som webbläsare inte skickar till servrar, och webbplatsen säger åt webbläsare att inte heller skicka sidans adress vidare till andra webbplatser. Appen skickar aldrig hemligheten någonstans, om inte avsändaren ber oss mejla länken (se Mejlade länkar nedan). Utöver det tar den bara fram nycklar ur den och håller mottagarsidans första adress, med hemligheten, i minnet, så att fältet "Gå tillbaka" kan föra dig tillbaka till en överföring som inte är klar. Länken i fältet har bara sökvägen; när du följer den hamnar hemligheten i adressfältet igen.',
          "Varje mottagare får ett eget länk-ID och en egen hemlighet, så en mottagares länk säger ingenting om någon annans.",
        ],
      },
      keys: {
        heading: "Nycklar",
        body: [
          "Två nycklar tas fram ur hemligheten med HKDF-SHA-256. Båda är AES-256-GCM-nycklar som webbläsaren markerar som icke-exporterbara: sidan kan använda dem men inte läsa ut dem.",
          "Signalnyckeln krypterar meddelandena för uppkopplingen. Dess salt är länk-ID:t.",
          "Filnyckeln krypterar varje ram mellan webbläsarna utom den första, INIT, som bara innehåller det slumpmässiga överförings-ID:t. Dess salt består av två slumpmässiga värden: ett överförings-ID som avsändaren väljer för varje försök och ett försöks-ID som mottagarens sida väljer varje gång den ansluter. Därför använder varken en omstartad överföring eller en återuppspelad första ram samma nyckel och nonce två gånger.",
        ],
      },
      signal: {
        heading: "Så kopplas webbläsarna ihop",
        body: [
          "Avsändarens sida öppnar en WebSocket mot vår server och anmäler sina länk-ID:n. När mottagaren öppnar sin länk ansluter deras sida med länk-ID:t och ett slumpmässigt försöks-ID, nytt för varje sidladdning och varje nytt försök. Servern kopplar ihop högst en mottagarsida med en länk åt gången och meddelar båda sidor.",
          "Sedan sätter webbläsarna upp en WebRTC-anslutning. Erbjudandet, svaret och nätverkskandidaterna krypteras med signalnyckeln innan de når vår server. Varje meddelande är knutet till sin länk, sitt försök och sin riktning, så servern kan inte läsa eller ändra dem, inte skicka tillbaka ett meddelande till den sida som skickade det, inte flytta det till en annan länk och inte spela upp det i ett annat försök. Att spela upp gamla meddelanden kan som mest få ett försök att misslyckas, vilket en server ändå kan åstadkomma genom att kasta dem.",
          "Det betyder mer än integritet: meddelandena innehåller fingeravtrycken för WebRTC:s egen DTLS-kryptering. Eftersom servern inte kan ändra dem kan den inte ställa sig mellan de två webbläsarna. Allt det här bygger på att vår server inte har nyckeln. För en länk som vi mejlar har den haft nyckeln, så den skulle kunna läsa och ändra den länkens meddelanden och ställa sig emellan.",
          "Det är vad kontrollnumret är till för. Varje webbläsare gör ett nytt certifikat för varje anslutning, och mottagarens webbläsare skickar först ett åtagande för sitt fingeravtryck, en hash, innan avsändarens webbläsare gör sitt erbjudande. Båda webbläsarna räknar sedan fram sex siffror ur de två fingeravtrycken i sin egen anslutning. Med någon emellan finns det två anslutningar, så de två skärmarna visar olika nummer, och tack vare åtagandet kan den som står emellan bara gissa: en chans på miljonen per anslutning. Numret visas bara på skärmen och skickas eller sparas aldrig.",
          "När kontrollnumret är på, vilket det är som standard för en länk som vi mejlar, läser mottagaren upp sitt nummer och avsändaren jämför. Ingenting om filen skickas förrän båda har sagt att det stämmer, och ”Det skiljer sig” på någon av sidorna stoppar försöket. När mottagarens webbläsare har svarat på ett erbjudande ansluter den igen bara när mottagaren klickar på Försök igen, och avsändarens sida slutar erbjuda en länk efter 5 försök som tog slut innan båda bekräftat, vart och ett begränsat till 5 minuter. Kontrollen visar att ingen satt mellan de två webbläsarna. Den kan inte visa att själva sidans kod är ärlig.",
          "Om anslutningen till vår server bryts försöker båda sidorna ansluta igen av sig själva. Avsändarens sida anmäler sina länkar på nytt, utom länkar som vi har mejlat: dem glömde vår server med den gamla anslutningen, så de slutar fungera och avsändarens sida säger det. En mottagare som ännu höll på att ansluta försöker igen några gånger innan den ger upp. Under den första minuten efter att vår server har startat ber den en mottagare vars länk den ännu inte känner till att vänta, så att mottagaren fortsätter försöka medan avsändarens sida anmäler länken igen. En överföring som redan har börjat behöver inte vår server och fortsätter.",
        ],
      },
      layers: {
        heading: "Två lager kryptering",
        body: [
          "WebRTC krypterar anslutningen mellan webbläsarna med DTLS. Fidant litar inte bara på det: varje ram efter INIT krypteras också med AES-256-GCM under filnyckeln, som bara de två webbläsarna har. För en länk som vi mejlar har vår server haft länkens hemlighet, som filnyckeln tas fram ur, så den skulle kunna dekryptera ramarna genom att ställa sig emellan; med kontrollnumret på skulle den inte se mer än INIT och CHECK.",
          "Varje ram börjar med ett huvud på 10 byte med version, typ och löpnummer. Huvudet autentiseras tillsammans med ramen, och nonce byggs av riktningen och löpnumret, så de två riktningarna delar aldrig nonce. En webbläsare tar bara emot nästa löpnummer, så en ram som tappas, kastas om, upprepas eller ändras stoppar överföringen.",
        ],
      },
      frames: {
        heading: "Överföringen, ram för ram",
        body: [
          "När avsändaren väljer filen räknar webbläsaren ut dess SHA-256-kontrollsumma.",
          "INIT: avsändaren skickar överförings-ID:t. Det är den enda ramen som inte krypteras. Om den ändras blir filnyckeln en annan, och nästa ram går inte att dekryptera. Att spela upp den igen i ett senare försök fungerar inte heller, eftersom mottagarens nya försöks-ID ger en annan nyckel.",
          "CHECK: med kontrollnumret på, varje sidas svar när dess person jämfört numren, krypterat: stämmer eller skiljer sig. META väntar på båda.",
          "META: filens namn, storlek och typ och det namn avsändaren skrev, krypterat. Mottagaren ser dem och väljer.",
          "ACCEPT eller DECLINE: mottagarens svar, krypterat. ACCEPT visar också att mottagaren har nyckeln. Inga fildata skickas före det.",
          "CREDIT: hur många delar avsändaren får skicka, krypterat. Mottagaren ger 128 i taget och fler allteftersom de skrivs, så en långsam mottagare har aldrig mer än ungefär 6 MiB som väntar. En avsändare som kommer längre före än så stoppas.",
          "CHUNK: filen i lika stora ramar, högst 48 KiB var.",
          "END: filens exakta storlek och kontrollsumman som räknades ut när filen valdes.",
          "RECEIPT: kontrollsumman som mottagaren räknade ut på det som kom fram. Avsändaren räknar filen som levererad först när den stämmer.",
        ],
      },
      check: {
        heading: "Kontrollen av filen",
        body: [
          "Mottagarens webbläsare räknar kontrollsumman medan filen kommer fram och kontrollerar storleken, antalet delar, utfyllnaden och kontrollsumman mot END. Filen sparas bara om allt stämmer. Varje annat slut, till exempel en ram som inte går att dekryptera eller en förbindelse som stängs för tidigt, kastar det som har skrivits.",
          "Chrome och Edge kan skriva filen direkt till en plats på disken som mottagaren väljer. Andra webbläsare samlar den i minnet och startar nedladdningen i slutet, och för en fil över 256 MiB varnas mottagaren först. Nedladdningen märks alltid som rena binärdata, vilken typ avsändaren än anger, så en fil kan inte köras som en webbsida på Fidants webbplats.",
          "Namn med styrtecken, radavgränsare, Unicode-tecken som åsidosätter eller isolerar textriktning, tomma utfyllnadstecken eller långa följder av mellanslag nekas, så ett namn som slutar på .exe kan inte se ut att sluta på .pdf.",
        ],
      },
      padding: {
        heading: "Den exakta storleken döljs",
        body: [
          "Den som kan se den krypterade trafiken, till exempel nätverken på vägen eller vårt relä, ser hur stora ramarna är. Därför avrundas storleken uppåt med metoden Padmé, som lägger till högst 12 %, och sedan till hela delar. Alla ramar med fildata är lika stora, och utfyllnaden är nollor som mottagaren kontrollerar.",
          "Den exakta storleken finns bara i de krypterade META och END. META är alltid lika stor, så inte heller filnamnets längd syns.",
          "En delad hemlighet är högst 32 KiB, och varje delad hemlighet fylls ut till exakt en del. Appen ser till det: om en förbindelse bara tillåter meddelanden som är för små för en del på 32 KiB skickas ingenting över den, och avsändaren ser att hemligheten inte skickades. Med alla webbläsare vi testade i november 2026 (Chromium, Firefox och WebKit) är delen 48 KiB. Så varje delad hemlighet ser likadan ut på nätet, oavsett längd, och likadan som vilken fil som helst på upp till 48 KiB.",
        ],
      },
      travel: {
        heading: "Så färdas filen",
        body: [
          "Båda webbläsarna börjar med bara vår STUN-tjänst, så WebRTC provar de direkta vägarna först, utan reläet: över det lokala nätverket, eller via varje sidas offentliga adress, som webbläsaren får veta från den tjänsten. Filen går då direkt mellan webbläsarna. Avsändarens sida visar vilken väg varje förbindelse tog.",
          "När ingen direkt väg fungerar, vilket är vanligt på mobildata och kontorsnätverk, går trafiken via vårt TURN-relä i Stockholm. Webbläsarna lägger till reläet bara om avsändaren tillåter det, om det är tillgängligt och om ingen anslutning har kommit till stånd 3 sekunder efter att mottagaren har svarat. En sida som öppnades innan vi började lägga till reläet på det här sättet reserverar fortfarande reläadresser från början, tills den laddas om. För att lägga till reläet börjar webbläsarna koppla upp på nytt, med ett nytt erbjudande och svar, krypterade precis som de första. En direkt väg kan fortfarande vinna efter det. En förbindelse som behöver reläet kommer alltså i gång ungefär 3 sekunder senare, och en direkt väg som ännu inte är uppkopplad 3 sekunder efter att mottagaren har svarat, till exempel på ett nätverk som tappar många paket, kan hamna på reläet. Reläet för vidare krypterade paket. Det kan inte dekryptera dem och sparar dem inte. När den uppskattade kostnaden för vår trafik under månaden når vår budget stängs reläet och vår STUN-tjänst av till månadens slut, om vi inte slår på dem igen tidigare, till exempel genom att höja budgeten. Till dess kan en ny överföring bara ansluta där den klarar sig utan dem, till exempel på samma lokala nätverk, och misslyckas ofta annars.",
          "För att använda reläet behöver en webbläsare inloggningsuppgifter, som vår server skapar för varje ihopkoppling och bara ger till de två ihopkopplade sidorna. De slutar gälla efter 5 minuter. Vår server kontrollerar varje minut att reläet kan föra vidare trafik och erbjuder det när en kontroll lyckas. Den slutar erbjuda det efter två misslyckade kontroller i rad. Reläet får hemligheten bakom inloggningsuppgifterna från vår server, förseglad så att bara reläet kan öppna den. Webbläsare når reläet över UDP, eller över TLS på port 443 där ett nätverk bara släpper igenom webbtrafik. Reläet skickar bara vidare över UDP, och bara från sin egen adress. Det vägrar skicka till andra datorer på privata eller interna nätverk (med ett godtaget undantag: reläets egen server, se beslut 0007) och begränsar hur många anslutningar som går via det samtidigt.",
          "På alla vägar ser varje webbläsare den andras IP-adress, precis som i ett videosamtal.",
        ],
      },
      norelay: {
        heading: "Att neka reläet",
        body: [
          'Avsändaren kan bocka ur "Tillåt vårt relä om en direkt anslutning inte går". Vår server ger då inga inloggningsuppgifter till reläet för den sändningen, bara STUN-adressen, så en omodifierad webbläsare kan inte använda reläet. Avsändarens webbläsare upprätthåller också själv valet: den startar förbindelsen utan inloggningsuppgifter till reläet, vad vår server än skickar. Som extra skydd avslutar avsändarens webbläsare förbindelsen om den ändå ser att den går via reläet. Fildata skickas först när mottagaren har tackat ja, så i praktiken sker det innan något av den har passerat.',
          "Gränsen: en modifierad mottagare kan ändå skicka sin del via vårt relä med uppgifter från en annan ihopkoppling, eller via vilket offentligt relä som helst. Den mottagaren har ju nyckeln ändå. Valet avgör vilken infrastruktur som bär den krypterade trafiken, inte vem som kan läsa filen.",
        ],
      },
      recipients: {
        heading: "Flera mottagare och engångslänkar",
        body: [
          "En sändning kan gå till upp till 256 personer. Var och en har en egen länk, nyckel, förbindelse och överföring.",
          "En länk räknas som använd först när mottagarens RECEIPT stämmer. Därefter nekas den. En länk som redan är öppen i en flik nekas i en annan.",
          "Fram till dess kan länken öppnas igen: efter att mottagaren tackat nej, efter en bruten förbindelse eller efter en misslyckad kontroll. Varje nytt försök har ett nytt överförings-ID och ett nytt försöks-ID, och därmed en ny filnyckel. En länk med kontrollnummer slutar fungera efter 5 försök som tog slut innan båda hade bekräftat numret.",
          "Ingenting sparas, så en länk fungerar bara medan avsändarens sida är öppen. När den stängs glömmer vår server dess länkar inom en minut.",
        ],
      },
      secret: {
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
      email: {
        heading: "Mejlade länkar",
        body: [
          "Den som skickar en fil eller delar en hemlighet kan ange en mottagares e-postadress. Avsändarens sida skickar då ett meddelande till vår server med länk-ID:t, adressen, länkens hemlighet, namnet avsändaren skrev och sidans språk. Det är det enda fallet där en länks hemlighet lämnar webbläsaren. Om vår server vägrar skicka mejlet byter avsändarens sida ut länken mot en ny, eftersom vår server har sett den gamla länkens hemlighet.",
          "Vår server väljer ett slumpmässigt värde och mejlar mottagaren länken med värdet framför länkens hemlighet: https://fidant.se/r/<länk-ID>#e.<värde>.<hemlighet>. Den gör ett försök, med en tidsgräns, och försöker aldrig igen. Den har länkens hemlighet och avsändarens namn bara tills försöket är över, och sparar eller loggar dem aldrig. Mejlet är ren text. Det visar namnet avsändaren skrev, markerat som inte verifierat, och säger ingenting om vad som skickas, inte ens om det är en fil eller en delad hemlighet.",
          "Innan mottagarens sida ansluter skickar den värdet till vår server. Bara om det stämmer visar servern en maskerad adress, till exempel a***@example.se, och mejlar en sexsiffrig kod dit när mottagaren ber om den. En kod gäller i 10 minuter, och efter 5 felaktiga försök slutar den gälla. Rätt kod ger en slumpmässig token som bara den webbläsarfliken har, och servern kopplar inte ihop någon med en mejlad länk utan en sådan. Den som bara har länk-ID:t, eller en mejlad länk som har slutat fungera, kan inte se adressen, inte få oss att skicka koder och inte ansluta.",
          "Vår server har adressen, värdet, koderna och tokens i minnet medan avsändarens sida har länken. När avsändaren tar bort mottagaren, stänger sidan eller tappar anslutningen till vår server, eller när servern startas om, försvinner allt det och den mejlade länken slutar fungera. För att begränsa missbruk räknar servern mejl i en timme under en förvrängd form av varje adress (en HMAC med en slumpmässig nyckel), aldrig under själva adressen: högst 20 mejl i timmen från en anslutning, 50 från en IP-adress och 5 till en e-postadress, och högst 5 koder per länk, med 30 sekunders mellanrum, 5 i timmen som en IP-adress ber om och 10 i timmen till en e-postadress. Båda gränserna per IP-adress räknar en IPv6-adress efter dess första 48 bitar. Hela servern skickar högst 500 mejl och 500 koder i timmen, och räknar då bara tidpunkter för utskick, utan någon adress. Vem som helst kan nå gränserna för en e-postadress, eller för hela servern, så att inga fler mejl eller koder skickas i upp till en timme.",
          "Haken: nyckeln står i mejlet. Vår server har haft den, vår e-posttjänst och den som läser mejlet på vägen kan se den, och den ligger kvar i mottagarens inkorg. Koden hindrar att en vidarebefordrad länk eller en e-postskanner tar emot filen eller den delade hemligheten, men inte den som kan läsa inkorgen. Och eftersom vår server har haft nyckeln skulle den kunna ställa sig mellan de två webbläsarna för den länken, eller själv öppna länken. Kontrollnumret, som är ikryssat som standard för en länk som vi mejlar, gör att du kan upptäcka det: mottagaren läser upp numret på sin skärm, och om det inte är samma som på din skickas ingenting. Vill du undvika allt det här, låt ”Mejla länken åt mig” vara urkryssad och skicka länken själv.",
        ],
      },
      site: {
        heading: "Själva webbplatsen",
        body: [
          "Webbplatsen levereras bara över HTTPS, och webbläsare får besked om att aldrig använda vanlig HTTP för den. Att skicka och ta emot går inte utan en säker anslutning.",
          "En Content Security Policy låter sidorna hämta kod, stilar, typsnitt och anslutningar bara från vår egen webbplats och hindrar andra webbplatser från att visa dem i en ram. Det finns inga cookies, inga skript från tredje part och ingen spårning.",
          "WebSocketen för uppkopplingen nekar anslutningar som öppnas från andra webbplatser, och gränser skyddar servern mot överbelastning: antal anslutningar totalt och per adress, meddelanden per anslutning, länkar per avsändare, storleken på varje meddelande samt mejlen och koderna som beskrivs ovan.",
        ],
      },
      limits: {
        heading: "Det här skyddar den inte mot",
        body: [
          "Länken är nyckeln. Den som får tag på en länk kan öppna filen eller den delade hemligheten bakom den tills länken har använts. En länk som vi mejlar kräver också en kod som skickas till samma adress, så den som kan läsa den inkorgen kan öppna den. Skicka varje länk bara till den den är till, på ett sätt du litar på.",
          "För en länk som vi mejlar har vår server, vår e-posttjänst och mottagarens inkorg nyckeln. Vår server skulle kunna ställa sig mellan de två webbläsarna; med kontrollnumret på skulle du se det, eftersom de två numren skulle skilja sig.",
          "Din webbläsare kör den kod vår server skickar. En server som skickade annan kod skulle kunna läsa filer, och hoppa över kontrollnumret. Koden är offentlig, men webbläsare kan ännu inte kontrollera att det de fick stämmer med den.",
          "Avsändarens namn skrivs av avsändaren och kontrolleras inte.",
          "Den andra webbläsaren ser din IP-adress. Nätverken på vägen, och vårt relä när det används, ser båda IP-adresserna, när överföringen sker och ungefär hur stor filen är. Vår server ser båda IP-adresserna, vilken mottagare som ansluter till vilken avsändare och när, och hur många mottagare en avsändare har, och för en länk som vi mejlar mottagarens e-postadress. Så den får veta vem som skickar till vem, men inte vad, om den inte ställer sig mitt i en länk som vi har mejlat med kontrollnumret avstängt.",
          "Skadlig kod på någon av datorerna kan läsa filen innan den krypteras eller efter att den dekrypterats.",
          "När mottagaren kopierar en delad hemlighet hamnar den i enhetens urklipp, där urklippshistorik, synkning av urklippet till andra enheter och andra appar kan läsa den. När en delad hemlighet väl har visats kan Fidant inte nå den: den går varken att ta tillbaka eller radera.",
          "Fidant har ännu inte granskats av någon oberoende part.",
        ],
      },
      planned: {
        heading: "Planerat: verifierade överföringar",
        body: [
          "Inte byggt ännu. Planen: mottagaren skriver under ett kvitto med BankID innan filen går att öppna, och kvittot namnger filen. Filnyckeln delas, och vår server lämnar ut sin halva först när kvittot är underskrivet. Händelser hamnar i en granskningslogg där manipulation syns, förankrad med betrodda tidsstämplar.",
          "När det finns beskriver den här sidan det som ett nytt läge.",
        ],
        link: [
          "Designbesluten på GitHub",
          "https://github.com/sigill-labs/sigill/tree/main/docs/decisions",
        ],
      },
    } satisfies Record<string, Section>,
    modes: {
      send: {
        heading: "Vad som skickas",
        items: {
          file: {
            heading: "En fil",
            body: "Vilken fil som helst. Namn, storlek och typ skickas krypterade, och mottagaren ser dem och väljer att ladda ner filen eller tacka nej.",
          },
          secret: {
            heading: "En delad hemlighet",
            body: "Upp till 10 000 tecken som avsändaren skriver eller klistrar in, till exempel ett lösenord. Den skickas som en fil, utfylld till en fast storlek, och mottagarens sida visar den som text och laddar aldrig ner den.",
          },
        },
      },
      link: {
        heading: "Hur länken når mottagaren",
        items: {
          link: {
            heading: "Avsändaren skickar den vidare",
            body: "Avsändaren kopierar varje länk och skickar den själv, till exempel i en chatt eller ett mejl. Nyckeln i länken når aldrig vår server.",
          },
          emailed: {
            heading: "Vi mejlar den",
            body: "Avsändaren anger en e-postadress och vår server mejlar länken. Mottagaren behöver också en kod som skickas till samma adress. Vår server och e-posttjänsten ser då den länkens nyckel.",
          },
        },
      },
      route: {
        heading: "Vägen trafiken tar",
        items: {
          local: {
            heading: "Direkt, på samma nätverk",
            body: "När båda webbläsarna är på samma lokala nätverk ansluter de över sina lokala adresser. Filen går direkt mellan dem, och vår server och vårt relä ser ingenting av den. Varje webbläsare frågar ändå vår STUN-tjänst om sin offentliga adress, vilket visar den IP-adressen. De två webbläsarna frågar ungefär samtidigt, så vår STUN-tjänst kan oftast se vilka två adresser som hör ihop. Om du tillåter reläet och det är tillgängligt, och den här vägen inte är uppkopplad 3 sekunder efter att mottagaren har svarat, lägger webbläsarna till reläet, som då kan få veta att de två adresserna hör ihop.",
          },
          stun: {
            heading: "Direkt, via offentliga adresser",
            body: "Varje webbläsare frågar vår STUN-tjänst om sin offentliga adress, vilket visar vår STUN-tjänst den IP-adressen. De två webbläsarna frågar ungefär samtidigt, så vår STUN-tjänst kan oftast se vilka två adresser som hör ihop. Filen går sedan direkt mellan webbläsarna över internet. Om du tillåter reläet och det är tillgängligt, och den här vägen inte är uppkopplad 3 sekunder efter att mottagaren har svarat, lägger webbläsarna till reläet, som då kan få veta att de två adresserna hör ihop.",
          },
          relay: {
            heading: "Via vårt relä",
            body: "När ingen anslutning har kommit till stånd 3 sekunder efter att mottagaren har svarat och reläet är tillgängligt, lägger webbläsarna till vårt TURN-relä i Stockholm. Om inte en direkt väg ändå vinner går den krypterade trafiken sedan via reläet, över UDP eller över TLS på port 443. Reläet för vidare paket som det inte kan dekryptera och sparar dem inte.",
          },
          norelay: {
            heading: "Reläet nekat",
            body: "Avsändaren kan neka vårt relä för en sändning. Vår server ger då inga inloggningsuppgifter till reläet, och en förbindelse utan direkt väg misslyckas.",
          },
        },
      },
    },
    glossary: {
      webrtc: [
        "WebRTC",
        "Tekniken som finns i alla moderna webbläsare för att koppla ihop två webbläsare direkt, mest känd från videosamtal. Fidant använder den för att skicka filen mellan webbläsarna. Orden nedan är dess delar, och de som Fidant lägger till.",
      ],
      signaling: [
        "Signalering",
        "Att skicka meddelandena för uppkopplingen mellan två webbläsare innan de når varandra. WebRTC lämnar det till appen. Fidant skickar dem via vår server, krypterade så att servern inte kan läsa eller ändra dem, utom för en länk vi mejlar.",
      ],
      websocket: [
        "WebSocket",
        "En bestående förbindelse åt båda hållen mellan en sida och en server. Fidants sidor håller en öppen mot vår server för att skicka meddelandena för uppkopplingen.",
      ],
      sdp: [
        "Erbjudande och svar",
        "Meddelandena som beskriver varje sida av en WebRTC-förbindelse, bland annat fingeravtrycket för dess DTLS-certifikat. Avsändarens webbläsare gör erbjudandet och mottagarens webbläsare svaret.",
      ],
      ice: [
        "Kandidater",
        "Adresserna där en webbläsare kanske kan nås: på det lokala nätverket, dess offentliga adress eller en adress på ett relä. De två webbläsarna byter kandidater och provar par av dem tills ett fungerar.",
      ],
      stun: [
        "STUN",
        "En tjänst som talar om för en webbläsare vilken offentlig adress den har, adressen internet ser den från bakom en router. Vår STUN-tjänst körs på samma maskin som vårt relä.",
      ],
      turn: [
        "TURN",
        "Ett relä som för vidare trafiken mellan två webbläsare som inte når varandra direkt. Vårt relä är en TURN-server. Det för vidare krypterade paket som det inte kan läsa.",
      ],
      dtls: [
        "DTLS",
        "Krypteringen som WebRTC alltid lägger på förbindelsen mellan två webbläsare, ungefär som TLS som HTTPS använder. Varje webbläsare kontrollerar den andras certifikat mot fingeravtrycket i erbjudandet eller svaret.",
      ],
      channel: [
        "Datakanal",
        "En WebRTC-förbindelse som bär data i stället för ljud och bild. Fidant skickar sina ramar över en sådan.",
      ],
      aes: [
        "AES-256-GCM",
        "Krypteringen som Fidant lägger till ovanpå DTLS, med en nyckel på 256 bitar. Den upptäcker också varje ändring av det den krypterat.",
      ],
      hkdf: [
        "HKDF-SHA-256",
        "Ett standardsätt att ta fram flera nycklar ur en hemlighet. Fidant tar fram signalnyckeln och filnyckeln ur hemligheten i länken.",
      ],
      sha: [
        "SHA-256",
        "En kontrollsumma: varje ändring av en fil, hur liten den än är, ger ett helt annat värde. Mottagarens webbläsare jämför filens kontrollsumma med avsändarens.",
      ],
      nonce: [
        "Nonce",
        "Ett tal som aldrig får användas två gånger med samma nyckel. Fidant bygger det av riktningen och ramens löpnummer.",
      ],
      fragment: [
        "Fragment",
        "Delen av en adress efter tecknet #. Webbläsare skickar den inte till servrar, så det är där länken har sin hemlighet.",
      ],
      padme: [
        "Padmé",
        "Ett sätt att avrunda en storlek uppåt så att den bara syns ungefär. Det lägger till högst 12 %.",
      ],
      hmac: [
        "HMAC",
        "En kontrollsumma gjord med en nyckel. Vår server har e-post- och IP-adresserna den räknar för sina gränser bara som HMAC, med en slumpmässig nyckel som bara finns i dess minne.",
      ],
    },
    linkRisks: {
      heading: "Vem som kan se nyckeln",
      body: ["Hur länken når mottagaren avgör vem mer som kan se nyckeln i den."],
      columns: ["Hur länken skickas", "Vem mer som kan se nyckeln", "Det här begränsar risken"],
      rows: [
        [
          "Avsändaren skickar den vidare",
          "Den som kan läsa kanalen avsändaren använder, till exempel chatt- eller e-posttjänsten.",
          "Länken fungerar bara tills dess fil har levererats, och bara medan avsändarens sida är öppen. Skicka varje länk bara till den den är till, på ett sätt du litar på.",
        ],
        [
          "Vi mejlar den",
          "Vår server medan den skickar mejlet, vår e-posttjänst, den som läser mejlet på vägen, mottagarens e-postleverantör och den som kan läsa den brevlådan.",
          "Mottagarens webbläsare ansluter först efter en sexsiffrig kod som skickas till samma adress, och som gäller i 10 minuter och 5 försök. Vår server skulle kunna ställa sig mellan de två webbläsarna för den länken, vilket kontrollnumret visar om du inte har stängt av det.",
        ],
      ],
    },
    protect: {
      heading: "Så skyddar Fidant dig",
      body: ["Varje risk, och vad i Fidant som står emot den. Avsnitten ovan förklarar varje del."],
      columns: ["Risken", "Det här gör Fidant"],
      rows: [
        [
          "Vår server eller vårt värdföretag läser filen",
          "Filen krypteras i din webbläsare med en nyckel ur delen av länken efter #, som webbläsare aldrig skickar till en server. Bara den som har länken kan dekryptera den. Undantaget är en länk vi mejlar, vars nyckel vår server och e-posttjänsten ser. Allt detta bygger på att koden vi levererar är den publicerade koden (se Det här skyddar den inte mot).",
        ],
        [
          "Vår server ställer sig mellan de två webbläsarna",
          "Meddelandena för uppkopplingen är krypterade och knutna till sin länk, sitt försök och sin riktning. De innehåller fingeravtrycken för WebRTC-krypteringen, som servern därför inte kan byta mot sina egna. För en länk vi mejlar hade servern nyckeln och skulle kunna byta dem; då visar de två skärmarna olika kontrollnummer, så med kontrollnumret på skulle du upptäcka det.",
        ],
        [
          "Nätverken på vägen eller vårt relä läser trafiken",
          "Två lager kryptering: WebRTC:s DTLS, och AES-256-GCM under en filnyckel som bara de två webbläsarna har, ny för varje försök. För en länk vi mejlar skulle vår server också kunna få filnyckeln genom att ställa sig emellan (se ovan), vilket kontrollnumret visar när det är på.",
        ],
        [
          "Trafiken avslöjar filnamnet, den exakta storleken eller en hemlighets längd",
          "Namn, typ och storlek skickas bara krypterade, i en ram med fast storlek. En fil fylls ut så att storleken bara syns ungefär, och varje delad hemlighet fylls ut till samma enda del.",
        ],
        [
          "En del av filen ändras, tappas, upprepas eller kastas om",
          "Varje ram är autentiserad och numrerad, och mottagaren kontrollerar storleken och SHA-256-kontrollsumman. Allt annat stoppar överföringen och kastar det som har skrivits.",
        ],
        [
          "En länk öppnas två gånger, eller av någon annan efter leveransen",
          "En länk nekas när dess fil har levererats, och i en andra flik medan den är öppen i en.",
        ],
        [
          "En mejlad länk vidarebefordras eller hämtas av en e-postskanner",
          "Mottagarens webbläsare ansluter först efter en sexsiffrig kod som skickas till samma adress. En kod gäller i 10 minuter och 5 felaktiga försök gör den ogiltig.",
        ],
        [
          "En fil som utger sig för något annat genom sitt namn, eller som körs som en sida",
          "Namn som döljer sin verkliga ändelse med tecken för textriktning nekas, och nedladdningar är alltid rena binärdata.",
        ],
        [
          "En delad hemlighet blir kvar i webbläsaren",
          "Hos mottagaren laddas den aldrig ner och läggs aldrig i ett formulärfält, och översättning är avstängd. Avsändarens textruta säger åt webbläsaren att hålla stavningskontroll, autokomplettering, skrivförslag och översättning borta från den. Den kan ändå bli kvar på två sätt: en webbläsare kan spara avsändarens textruta med sessionen, och en kopierad hemlighet ligger kvar i urklippet (se Det här skyddar den inte mot).",
        ],
        [
          "Data som blir kvar på våra maskiner",
          "Inga konton, ingen fillagring och ingen databas över personer eller överföringar. Servern har det den vet om sidor bara i minnet och glömmer en sida inom en minut efter att den kopplat ner, utom förvrängda antal mejl och koder och två räknare med sändningstider för hela servern, som den sparar i en timme. Loggarna har fasta fält, aldrig namn, e-postadresser, koder, nycklar, filinnehåll eller IP-adresser, och raderas efter 30 dagar. Reläet för som standard ingen logg över trafiken. Medan det förnyar sitt certifikat loggar det i ungefär fem veckor adresserna som når det på port 80, aldrig webbläsarnas.",
        ],
        [
          "Spårning, eller kod från andra webbplatser",
          "Bara HTTPS, inga cookies, inga skript eller spårare från tredje part, och en Content Security Policy som bara tillåter kod från vår egen webbplats.",
        ],
        [
          "Du vill inte att din trafik går via vårt relä",
          "Bocka ur reläet för den sändningen. Vår server ger då inga inloggningsuppgifter till reläet, och avsändarens webbläsare avslutar en förbindelse som går via det.",
        ],
      ],
    },
    explorer: {
      heading: "Se vad din överföring lämnar efter sig",
      body: [
        "Välj hur du skickar, så ser du varje plats som sparar ett spår av det: vad den sparar och hur länge. Platser som din väg inte använder säger det.",
      ],
      questions: {
        what: { legend: "Vad skickar du?", options: { file: "En fil", secret: "En hemlighet" } },
        link: {
          legend: "Hur når länken mottagaren?",
          options: { self: "Jag skickar den själv", email: "Fidant mejlar den" },
        },
        route: {
          legend: "Vilken väg tar den krypterade trafiken?",
          options: {
            direct: "Direkt, med vårt relä tillåtet",
            relay: "Via vårt relä",
            norelay: "Direkt, med vårt relä avböjt",
          },
        },
      },
      kept: "Sparas",
      never: "Aldrig",
      notUsed: "Ingår inte i den här vägen.",
      link: ["Alla loggfält, på integritetssidan", "/privacy"] as readonly [string, string],
      places: {
        sender: {
          name: "Din webbläsare",
          kept: "Mest tills du stänger fliken",
          never: "Fidant sparar ingen fil, hemlighet, länk eller nyckel på din enhet.",
          lines: [
            [
              "",
              "Länkarna, deras nycklar och överföringarna, bara i den här flikens minne, tills du stänger den.",
            ],
            [
              "",
              "En länk du kopierar, i ditt urklipp tills du kopierar något annat. Urklippshistorik, synkade urklipp och andra appar kan spara den längre.",
            ],
            [
              "file",
              "Din fil ligger kvar där den är. Sidan läser den för att kryptera den och kopierar den ingenstans.",
            ],
            [
              "secret",
              "Hemligheten, i sin textruta tills du stänger fliken. Webbläsaren kan också spara den med sessionen, för att återställa den efter en krasch eller en återöppnad flik.",
            ],
            ["", "Ditt val av tema och språk, i webbläsarens lokala lagring, tills du rensar den."],
            [
              "direct,relay",
              "Så länge vårt relä är tillgängligt: inloggningsuppgifter till reläet, gjorda för det här paret av webbläsare, i minnet medan sidan är öppen. Med dem kan en reläanslutning starta i 5 minuter.",
            ],
          ],
        },
        channel: {
          name: "Där du klistrar in länken",
          kept: "Så länge den tjänsten sparar meddelanden",
          never: "Fidant ser aldrig det meddelandet.",
          lines: [
            [
              "self",
              "Hela länken, nyckeln också, i den chatt-, mejl- eller meddelandetjänst du skickar den med. Tjänstens förhandsvisning av länken kan öppna adressen men får aldrig nyckeln, som står efter #.",
            ],
          ],
        },
        server: {
          name: "Vår server, i minnet",
          kept: "Medan sidorna är öppna, och upp till en minut efter. Mejlräknare: upp till en timme",
          never:
            "Din fil, dess namn, storlek eller typ, eller hemligheten eller dess längd, utom på en mejlad länk enligt nedan.",
          lines: [
            [
              "",
              "Båda IP-adresserna, länkens ID och vilken sida som är ihopkopplad med vilken länk.",
            ],
            [
              "",
              "Krypterade uppkopplingsmeddelanden passerar och sparas inte. På en länk du skickar själv kan den inte läsa dem.",
            ],
            [
              "direct,relay",
              "Så länge vårt relä är tillgängligt skapar den inloggningsuppgifter till reläet för det här paret av webbläsare, giltiga i 5 minuter, och skickar dem till båda sidorna utan att spara dem.",
            ],
            [
              "email",
              "Mottagarens mejladress, ett slumpvärde och koden, medan din sida är öppen. Länkens nyckel och namnet du skrev bara tills mejlet har skickats eller misslyckats.",
            ],
            [
              "email",
              "Den har haft nyckeln, så den skulle kunna läsa länkens uppkopplingsmeddelanden och försöka ställa sig mellan webbläsarna. Kontrollnumret visar dig om den gör det, om du inte har stängt av det.",
            ],
            [
              "email",
              "För att upprätthålla gränser, i upp till en timme: sändningstider, sparade under nyckelstyrda hashar (HMAC) av mottagarens adress och av din IP-adress, och två räknare för hela servern, en för alla mejl och en för alla koder, utan koppling till någon adress.",
            ],
            ["email", "Token som rätt kod ger, medan din sida är öppen."],
          ],
        },
        proxy: {
          name: "Vår frontproxy",
          kept: "Medan någon anslutning från den är öppen, och upp till 2 minuter efter att den sista stängts",
          never:
            "Något av det den för vidare: den dekrypterar inte trafiken. Den loggar ingenting.",
          lines: [
            [
              "",
              "Varje IP-adress som ansluter (för IPv6 dess /64-block) och hur många anslutningar den har, i minnet.",
            ],
          ],
        },
        caddy: {
          name: "Vår webbserver (Caddy)",
          kept: "Ingen åtkomstlogg. Dess egen logg: 30 dagar",
          never: "Delen av länken efter #, som webbläsare aldrig skickar.",
          lines: [
            [
              "",
              "Den dekrypterar HTTPS och ser därför, bara i minnet, varje förfrågans sökväg (som /r/ med länkens ID), varje webbläsares IP-adress och alla meddelanden sidorna skickar till vår server. Uppkopplingsmeddelandena förblir krypterade.",
            ],
            [
              "email",
              "På en mejlad länk ingår mottagarens mejladress, namnet du skrev, länkens nyckel, koden och token i de meddelandena.",
            ],
            [
              "",
              "Dess egen logg, om uppstart, går till systemets journal. Den har ingen åtkomstlogg, och dess fel- och TLS-loggar är avstängda.",
            ],
          ],
        },
        log: {
          name: "Vår serverlogg",
          kept: "30 dagar",
          never: "Namn, mejladresser, koder, nycklar, IP-adresser eller filinnehåll.",
          lines: [
            [
              "",
              "Korta rader med en fast lista med fält: att en avsändare registrerade sig och hur många länkar, att en mottagare anslöt, storleken på varje uppkopplingsmeddelande och vilken väg anslutningen tog. En länk syns bara med sina 6 första tecken.",
            ],
            [
              "email",
              "Om mejlet skickades, varje kod som skickades eller nekades, och en rätt kod.",
            ],
            [
              "",
              "Att en mottagare lämnade, och att din sida stängdes, med hur många länkar den hade.",
            ],
            [
              "direct,relay",
              "Om vårt relä är tillgängligt och webbläsarna fortfarande inte är anslutna 3 sekunder efter att mottagaren svarat, lägger de till reläet. Det ger rader för ytterligare ett dussintal uppkopplingsmeddelanden, som antyder att du tillät reläet.",
            ],
            [
              "norelay",
              "Om en anslutning via reläet ändå kommer till stånd: att din sida avslutade den.",
            ],
          ],
        },
        relay: {
          name: "Vårt relä",
          kept: "Inget när trafiken har passerat. Vissa loggar: upp till ungefär fem veckor",
          never:
            "Nyckeln, filen eller hemligheten. Reläet kan inte låsa upp något av det som passerar.",
          lines: [
            [
              "",
              "Varje webbläsares publika IP-adress, när webbläsaren frågar efter den. De två webbläsarna frågar ungefär samtidigt, så reläet kan oftast se vilka två adresser som hör ihop.",
            ],
            [
              "direct",
              "Om vårt relä är tillgängligt och webbläsarna fortfarande inte är anslutna 3 sekunder efter att mottagaren svarat: båda IP-adresserna tillsammans, även om en direkt väg vinner till slut. Båda webbläsarna reserverar då en reläadress. Bara din gör det om mottagarens webbläsare redan var ansluten när din sidas begäran om att lägga till reläet kom fram. Reläet kan få veta båda IP-adresserna i båda fallen.",
            ],
            [
              "relay",
              "Båda IP-adresserna, och den krypterade trafiken, som det skickar vidare och inte sparar.",
            ],
            ["relay file", "Filens storlek, bara ungefär."],
            ["relay secret", "Inte hemlighetens längd: varje hemlighet är lika stor på nätet."],
            [
              "",
              "Ingen logg över trafiken. Vi slår bara på en för att rätta ett fel eller stoppa missbruk, i högst 7 dagar, med anslutningstider, IP-adresser och datamängder.",
            ],
            [
              "",
              "Medan reläet förnyar sitt certifikat, några sekunder ungefär varannan månad, loggar det adresserna som når det på port 80. De kommer från Let's Encrypts kontroller och skannrar på internet, aldrig från webbläsare, och raderas inom ungefär fem veckor.",
            ],
            [
              "",
              "Sin egen nuvarande och förra hemlighet, som inte innehåller några spår av din överföring.",
            ],
          ],
        },
        relayCap: {
          name: "Vår mätning av månadens trafik",
          kept: "Upp till 15 månader; hos vårt värdföretag 455 dagar",
          never:
            "Vilken överföring trafiken hör till, IP-adresser, nyckeln, filen eller hemligheten.",
          lines: [
            [
              "",
              "Sidorna din webbläsare hämtar, meddelandena den utbyter med vår server och dess frågor till vårt relä. De räknas ihop med all annan trafik genom dem, så att vi kan stänga av reläet när den uppskattade kostnaden når vår budget.",
            ],
            [
              "relay",
              "Din överförings krypterade storlek, avrundad uppåt, räknas in i trafiken för reläet som bar den. Vi sparar månadens summor för vår server och vårt relä var 5:e minut, så på ett lugnt relä kan steget mellan två sparade värden motsvara din överförings storlek och tid.",
            ],
            [
              "",
              "Månadens summor tills nästa månad börjar, och deras senaste 100 versioner, som täcker ungefär 8 timmar.",
            ],
            [
              "",
              "Månadens summa som den såg ut var 5:e minut, i 63 dagar, och varje timme, i 15 månader. Mätningens egen logg sparar den i 30 dagar.",
            ],
            [
              "",
              "Vårt värdföretag, Amazon Lightsail, sparar hur mycket trafik vår server och vårt relä har burit, i 455 dagar.",
            ],
          ],
        },
        mail: {
          name: "Vår mejltjänst och mottagarens inkorg",
          kept: "Tills mejltjänsten och mottagarens mejlleverantör raderar mejlen, enligt egna regler",
          never: "Filens namn, storlek eller typ, eller om det är en fil eller en hemlighet.",
          lines: [
            [
              "email",
              "Ett mejl med hela länken, nyckeln också, och namnet du skrev, markerat som okontrollerat. Ett andra mejl med koden. Den som läser mejlet på vägen, eller en länkskanner som hämtar länken, kan få hela länken med nyckeln. En skanner kan inte ansluta utan koden.",
            ],
          ],
        },
        recipient: {
          name: "Mottagarens webbläsare",
          kept: "Mest tills fliken stängs",
          never:
            "Fidant sparar ingen nyckel på deras enhet, utöver det webbläsarens historik sparar.",
          lines: [
            [
              "",
              "Länken, nyckeln också, i webbläsarens historik som vilken adress som helst. Din sida nekar länken när leveransen är klar, och länken fungerar bara medan din sida är öppen.",
            ],
            [
              "file",
              "Filen, där de sparar den: Chrome och Edge skriver den dit mottagaren väljer, andra webbläsare till sina nedladdningar.",
            ],
            [
              "secret",
              "Hemligheten, bara i sidans minne tills de kopierar den. Då ligger den också i deras urklipp, där urklippshistorik, synkade urklipp och andra appar kan läsa den.",
            ],
            ["email", "En token för rätt kod, i flikens sessionslagring tills fliken stängs."],
            [
              "direct,relay",
              "Så länge vårt relä är tillgängligt: inloggningsuppgifter till reläet, gjorda för det här paret av webbläsare, i minnet medan sidan är öppen. Med dem kan en reläanslutning starta i 5 minuter.",
            ],
            ["", "Deras val av tema och språk, i webbläsarens lokala lagring, tills de rensas."],
          ],
        },
        networks: {
          name: "Näten på vägen",
          kept: "Okänt",
          never: "Något läsbart: all trafik är krypterad.",
          lines: [
            ["", "Båda IP-adresserna och tidpunkterna."],
            ["file", "Filens storlek, bara ungefär."],
            ["secret", "Inte hemlighetens längd: varje hemlighet är lika stor på nätet."],
          ],
        },
      },
    },
    data: {
      heading: "Steg för steg",
      body: [
        "Samma sak i den ordning en överföring sker: vad vår server ser, sparar och loggar i varje steg, och vad vårt relä ser. En delad hemlighet går igenom samma steg som en fil.",
      ],
      columns: ["Steg", "Vår server ser", "Vår server sparar", "Vår server loggar", "Vårt relä"],
      rows: [
        [
          "Du öppnar webbplatsen",
          "Din IP-adress och dina webbläsaruppgifter, som alla webbplatser.",
          "Ingenting. En sändarsida öppnar också en anslutning till vår server, som servern håller i minnet medan sidan är öppen.",
          "Ingenting.",
          "Ingenting.",
        ],
        [
          "Du väljer fil eller skriver hemligheten, och lägger till mottagare",
          "Ingenting. Din webbläsare läser filen, räknar ut kontrollsumman och skapar länkarna själv.",
          "Ingenting.",
          "Ingenting.",
          "Ingenting.",
        ],
        [
          "Din sida anmäler sina länkar",
          "Länk-ID:na, ditt val om reläet och din IP-adress.",
          "Länk-ID:na och ditt val om reläet, i minnet, medan din sida är öppen.",
          "Att en avsändare anmälde sig, och hur många länkar.",
          "Ingenting.",
        ],
        [
          "Du ber oss mejla en länk",
          "Mottagarens e-postadress, länkens hemlighet, namnet du skrev och sidans språk. E-posttjänsten får mejlet med länken.",
          "Adressen, språket och ett slumpmässigt värde medan din sida har länken. Hemligheten och ditt namn bara tills mejlet har skickats eller misslyckats. Antal mejl per förvrängd e-postadress och per förvrängd IP-adress, och ett antal för alla mejl servern skickat, utan koppling till någon adress, i en timme.",
          "Om mejlet skickades, med de 6 första tecknen i länk-ID:t.",
          "Ingenting.",
        ],
        [
          "En mottagare med en mejlad länk anger koden",
          "Värdet ur länken och koden som skrevs.",
          "Den senaste koden med dess giltighetstid och försök, och den token en rätt kod ger, medan din sida har länken. Antal koder per förvrängd e-postadress och per förvrängd IP-adress, och ett antal för alla koder servern skickat, utan koppling till någon adress, i en timme.",
          "Varje kod som skickades eller nekades och varför, och en rätt kod, med de 6 första tecknen i länk-ID:t.",
          "Ingenting.",
        ],
        [
          "En mottagare öppnar sin länk",
          "Länk-ID:t, ett slumpmässigt försöks-ID och mottagarens IP-adress och webbläsaruppgifter.",
          "Vilken mottagarsida som är ihopkopplad med vilken länk, i minnet.",
          "Att en mottagare anslöt eller nekades och varför, med de 6 första tecknen i länk-ID:t.",
          "Ingenting än. Om du tillåter reläet och det är tillgängligt ger vår server de två sidorna inloggningsuppgifter till det som slutar gälla efter 5 minuter.",
        ],
        [
          "Webbläsarna kopplar upp sig",
          "Krypterade meddelanden för uppkopplingen och deras storlek. Den kan inte läsa dem, utom för en länk vi mejlat.",
          "Ingenting. Den skickar dem vidare.",
          "Varje meddelandes storlek, med de 6 första tecknen i länk-ID:t.",
          "Varje webbläsares IP-adress, när den frågar efter sin offentliga adress (STUN). Om du tillåter reläet och det är tillgängligt, och webbläsarna fortfarande inte är anslutna 3 sekunder efter att mottagaren svarat, lägger de till reläet. Båda reserverar då en reläadress. Bara din gör det om mottagarens webbläsare redan var ansluten när din sidas begäran om att lägga till reläet kom fram. Reläet kan få veta båda IP-adresserna i båda fallen, även om en direkt väg vinner till slut.",
        ],
        [
          "Filen eller hemligheten skickas",
          "Ingenting av den. Din sida rapporterar vägen: direkt, STUN, relä eller misslyckad.",
          "Ingenting.",
          "Vägen.",
          "På vägen via reläet: de krypterade paketen, som det för vidare och inte sparar. Båda IP-adresserna så fort webbläsarna har lagt till reläet.",
        ],
        [
          "Mottagaren bekräftar leveransen",
          "Ingenting. Kvittot går mellan webbläsarna. Om länken öppnas igen nekar din sida den som använd.",
          "Ingenting.",
          'Ett senare nekande, med orsaken "used".',
          "Ingenting.",
        ],
        [
          "En sida stängs",
          "Att sidan kopplade ner.",
          "Ingenting om den sidan, inom en minut. När din sida stängs försvinner också en mejlad länks adress, koder och tokens.",
          "Att en avsändare lämnade och hur många länkar den hade, eller att en mottagare lämnade, med de 6 första tecknen i länk-ID:t.",
          "Ingenting.",
        ],
        [
          "Efteråt",
          "Ingenting.",
          "Bara de förvrängda antalen mejl och koder, och två räknare för hela servern med tiderna då mejl och koder skickades, utan koppling till någon adress, i högst en timme.",
          "Loggraderna raderas efter 30 dagar.",
          "Ingen logg över trafiken. Vi slår bara på en för att rätta ett fel eller stoppa missbruk, i högst 7 dagar, med anslutningstider, IP-adresser och datamängder. Medan reläet förnyar sitt certifikat loggar det också adresserna som når det på port 80, aldrig webbläsares, i ungefär fem veckor.",
        ],
      ],
    },
  },
  privacy: {
    title: "Integritet",
    lede: "Vi får aldrig din fil eller delade hemlighet, eller dess namn. Vi får inte heller nyckeln som låser upp den, om du inte ber oss mejla länken. Här nedan står vad vi ser och sparar, och hur länge.",
    neverHeading: "Det här får vi aldrig",
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
    seesHeading: "Det här ser vår server, och bara för att koppla ihop er eller mejla en länk",
    sees: [
      [
        "Din IP-adress och uppgifter om din webbläsare",
        "Som på alla webbplatser du besöker, och vilken sida du öppnar, vars adress visar vilket språk du har valt. Vi använder dem bara för att visa dig sidan och koppla ihop er. Vår server skriver aldrig in dem i sina loggar. Vårt relä loggar dem inte heller, utom medan vi åtgärdar ett fel eller stoppar missbruk (se nedan).",
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
        "Antal mejl och koder",
        "För att begränsa hur många mejl någon kan skicka räknar vi under en timme mejlen och koderna till varje adress och mejlen och koderna som varje IP-adress ber oss skicka. Varje antal per adress sparas under en förvrängd form av adressen (en HMAC), aldrig under själva adressen. Två räknare till, för alla mejl och alla koder som servern skickat, innehåller bara sändningstider och har ingen koppling till någon adress.",
      ],
    ],
    keepHeading: "Vad vi sparar",
    keep: "Vi har inga konton, ingen databas över personer eller överföringar, inga cookies och ingen spårning. Förutom loggraderna nedan, en relälogg medan vi åtgärdar ett fel eller stoppar missbruk, antalet mejl och koder ovan, som finns kvar en timme, och e-posttjänstens lista över adresser som studsat sparas ingenting om dig när avsändarens sida har stängts, inom högst två minuter.",
    logFields,
    logRetention: "Loggraderna raderas efter 30 dagar.",
    relayLog:
      "Vårt relä, som kan föra den låsta filen vidare när två webbläsare inte kan ansluta direkt, för ingen logg över trafiken. Bara för att åtgärda ett fel eller stoppa missbruk slår vi på en. Den sparar då för varje vidarebefordrad anslutning båda IP-adresserna och portarna, när den började och slutade och hur mycket data som gick igenom. Aldrig namn, nycklar eller fildata. Vi stänger av den och raderar den inom 7 dagar. Dessutom loggar reläet adresserna som når det på port 80 medan det förnyar sitt certifikat, några sekunder ungefär varannan månad. Det är Let's Encrypts kontroller och skannrar på internet, aldrig webbläsare, och de raderas inom ungefär fem veckor.",
    limitsHeading: "Det här kan vi inte skydda dig mot",
    limits: [
      "Den som har länken kan öppna filen. En länk vi mejlar kräver också en kod som vi skickar till samma adress, så den som kan läsa den inkorgen kan öppna den. Skicka varje länk bara till den som den är avsedd för.",
      "Din webbläsare kör den kod vår server skickar. En server som skickade annan kod skulle kunna läsa filer, och hoppa över kontrollnumret. Koden är offentlig, men webbläsare kan ännu inte kontrollera att det de fick stämmer med den.",
      "Den andra webbläsaren ser din IP-adress, precis som i ett videosamtal. Vår server ser båda IP-adresserna, vilken mottagare som ansluter till vilken avsändare och när, och hur många mottagare en avsändare har. Så den får veta vem som skickar till vem, men inte vad, utom för en länk vi mejlat med kontrollnumret avstängt.",
      "Varje webbläsare frågar vårt relä om sin offentliga adress, så reläet ser varje IP-adress. Nätverken på vägen, och vårt relä när filen går via det, ser båda IP-adresserna, när överföringen sker och ungefär hur stor filen är.",
    ],
    limitsLink: ["Varje risk, och vad Fidant gör åt den", "/how/protection"] as readonly [
      string,
      string,
    ],
    checkHeading: "Kontrollera själv",
    check:
      "Den här sidan är den korta versionen. Så fungerar det förklarar varje steg, och varje påstående här går att kontrollera mot den offentliga koden.",
    checkLinks: [
      ["Så fungerar det, steg för steg", "/how"],
      ["Det som ses och sparas i varje steg", "/how/traces"],
      ["Koden på GitHub", "https://github.com/sigill-labs/sigill"],
    ] as ReadonlyArray<readonly [string, string]>,
    contactHeading: "Kontakt",
    contact:
      "Fidant är ett projekt med öppen källkod, och inget företag eller ingen person ansvarar för det än. Frågor om integritet och dina uppgifter skickas till",
  },
};
