// Swedish text. Same keys as en.ts.

import type { LogFields } from "@sigill/protocol";
import type { Tie } from "../lib/server-facts.ts";
import type { Messages } from "./en.ts";

export const sv: Messages = {
  product: "Fidant",
  menu: {
    label: "Huvudmeny",
    send: "Skicka en fil",
    privacy: "Integritet",
    newTab: "(öppnas i en ny flik)",
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
  format: {
    bytes: (n: number) => `${n.toLocaleString("sv")} byte`,
    progress: (percent: string, done: string, total: string) => `${percent} · ${done} av ${total}`,
  },
  send: {
    title: "Skicka en fil",
    lede: "Din fil går direkt från den här webbläsaren till dem du väljer. Den krypteras på vägen och laddas aldrig upp eller sparas.",
    localhost:
      "Sidan är öppnad på localhost, så länkarna fungerar inte på andra datorer. Öppna i stället nätverksadressen som servern skrev ut.",
    lostServer:
      "Anslutningen till servern bröts. Filer som redan är på väg kan komma fram, men ingen ny kan ansluta. Ladda om sidan för att börja om.",
    fromLabel: "Ditt namn",
    optional: "(valfritt)",
    fromHint: "Visas för dem du skickar till.",
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
    fileFirst: "Välj en fil först.",
    full: (max: number) => `Du kan skicka till högst ${max} personer åt gången.`,
    oneLinkEach: "Varje person får en egen länk, som fungerar en gång.",
    keepOpen: "Ha fliken öppen tills alla har fått filen. Den skickas direkt härifrån.",
    recipients: "Mottagare",
    status: {
      waiting: (name: string) => `Väntar på att ${name} ska öppna länken`,
      connecting: (name: string) => `Ansluter till ${name}…`,
      offered: (name: string) => `Länken till ${name} har öppnats`,
      receiving: (name: string) => `Skickar till ${name}`,
      delivered: (name: string) => `Levererad via länken till ${name}`,
      failed: (name: string) =>
        `Filen kom inte fram oskadd till ${name}. Länken kan öppnas igen för att försöka på nytt.`,
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
    offerTitle: (from: string) =>
      from ? `${from} vill skicka en fil till dig` : "Du har fått en fil",
    unverified: "Namnet är skrivet av avsändaren och inte verifierat.",
    download: "Ladda ner",
    decline: "Tacka nej",
    offerCaption: (from: string) =>
      `Skickas direkt från ${from ? `datorn hos ${from}` : "avsändarens dator"} till din. Krypterad, sparas aldrig på någon server.`,
    receivingTitle: "Laddar ner…",
    progressLabel: "Förlopp för nedladdningen",
    receivingCaption: "Tar emot direkt från avsändaren. Ha fliken öppen tills det är klart.",
    doneTitle: "Nedladdningen är klar",
    verified: "Vi har kontrollerat den: det här är exakt den fil som skickades.",
    autoDownload: "Nedladdningen bör starta av sig själv.",
    savedWhereChosen: "Den är sparad där du valde.",
    saveFile: "Spara filen",
    doneCaption: "Skickad direkt från avsändarens dator till din. Krypterad hela vägen.",
    declinedTitle: "Du tackade nej till filen",
    declinedBody:
      "Du kan stänga fliken. Om du ändrar dig fungerar länken fortfarande medan avsändarens sida är öppen.",
    showAgain: "Visa filen igen",
    tryAgain: "Försök igen",
    whatHappened: "Vad som hände",
    encryptionLabel: "Kryptering",
    encryption:
      "AES-256-GCM, hela vägen från avsändaren till dig. Nyckeln finns i din länk och lämnar aldrig den här webbläsaren.",
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
        body: "Filen färdas direkt mellan era två datorer, och de kunde inte nå varandra.",
      },
      server: {
        title: "Det gick inte att nå servern",
        body: "Servern kopplar ihop dig med avsändaren. Kontrollera din internetanslutning.",
      },
    },
  },
  server: {
    heading: "Vad vår server har just nu",
    seesLabel: "Ser",
    holdsLabel: "Har",
    passedOnLabel: "Har skickat vidare",
    fileDataLabel: "Filinnehåll",
    logsLabel: "Loggar",
    afterwardsLabel: "Efteråt",
    seesSender:
      "Din IP-adress och de vanliga uppgifterna om webbläsaren som alla webbplatser får, och samma sak för varje mottagare när de öppnar sin länk.",
    seesRecipient:
      "Din IP-adress och de vanliga uppgifterna om webbläsaren som alla webbplatser får.",
    senderHolds: ({ online, links, connected }) => {
      if (!online) {
        return "Ingenting, när den har märkt att anslutningen har stängts. Det tar upp till en minut om nätverket bröts.";
      }
      if (links === 0) {
        return "Inga länkar ännu.";
      }
      const ids =
        links === 1
          ? "ID:t för din länk, aldrig den del som låser upp filen."
          : `ID:na för dina ${links} länkar, aldrig den del som låser upp filen.`;
      if (connected === 0) {
        return ids;
      }
      const who =
        connected === 1 ? "1 mottagare är ansluten" : `${connected} mottagare är anslutna`;
      return `${ids} ${who} just nu.`;
    },
    recipientHolds: (tie: Tie) =>
      ({
        paired:
          "ID:t för din länk, aldrig den del som låser upp filen, och att den här sidan är ansluten till avsändaren.",
        unpaired:
          "Ingenting som knyter den här sidan till din länk. Bara avsändarens sida kan hålla kvar din länks ID där.",
        closed:
          "Ingenting om den här sidan, när den har märkt att anslutningen har stängts. Det tar upp till en minut om nätverket bröts. Bara avsändarens sida kan hålla kvar din länks ID där.",
      })[tie],
    passedOn: (messages: number, size: string) =>
      messages === 0
        ? "Inget ännu."
        : `${messages} ${messages === 1 ? "uppkopplingsmeddelande" : "uppkopplingsmeddelanden"} (${size}), alla krypterade så att servern inte kan läsa dem.`,
    fileData: "Inget. Filen går direkt mellan webbläsarna.",
    senderAfterwards: (online: boolean) =>
      online
        ? "När du stänger den här fliken glömmer servern dina länkar, inom högst en minut. Loggraderna finns kvar."
        : "Dina länkar försvinner från servern inom en minut efter att anslutningen stängdes. Loggraderna finns kvar.",
    afterwardsRecipient:
      "När den här sidan kopplas från släpper servern det den har om sidan, inom högst en minut. Loggraderna finns kvar.",
    logs: `Vad som hände, till exempel att en länk öppnades, med ${new Intl.ListFormat("sv", {
      type: "conjunction",
    }).format(
      Object.values({
        link: "de 6 första tecknen i ett länk-ID",
        links: "hur många länkar en avsändare har",
        bytes: "meddelandens storlek",
        reason: "varför en länk eller anslutning nekades",
        code: "felkoder",
        port: "porten servern lyssnar på",
      } satisfies Record<keyof LogFields, string>),
    )}. Aldrig namn, nycklar, filinnehåll eller IP-adresser.`,
  },
  privacy: {
    title: "Integritet",
    lede: "Din fil går direkt från din webbläsare till webbläsaren hos den du skickar till. Den låses innan den lämnar din dator, och bara den som har länken kan låsa upp den. Vi får aldrig filen, dess namn eller nyckeln.",
    howHeading: "Så går det till att skicka",
    steps: [
      [
        "Du väljer en fil och lägger till dem du vill skicka den till.",
        "Filen stannar på din dator. Ingenting laddas upp.",
      ],
      [
        "Du får en länk per person.",
        "Varje länk innehåller nyckeln som låser upp filen. Du skickar länken själv, till exempel via mejl eller chatt.",
      ],
      [
        "De öppnar länken medan din sida fortfarande är öppen.",
        "Vår server hjälper de två webbläsarna att hitta varandra, som en telefonist som kopplar ett samtal.",
      ],
      ["De ser filens namn och storlek och väljer att ladda ner den, eller tackar nej.", ""],
      [
        "Filen går direkt från din dator till deras, låst hela vägen.",
        "Deras webbläsare låser upp den och kontrollerar att det är exakt den fil du skickade.",
      ],
    ],
    keepOpen:
      "Eftersom filen aldrig sparas någonstans behöver du ha sidan öppen tills alla har laddat ner den.",
    travelHeading: "Så färdas filen",
    lockedBox:
      "Tänk dig att du lämnar över en låst låda personligen. Det finns inget postkontor emellan som håller i den, och bara den som har nyckeln kan öppna den.",
    keyPart: [
      "Nyckeln är den sista delen av länken, efter tecknet ",
      ". Webbläsare skickar aldrig den delen till någon webbplats, inte heller till vår. Därför kan vi inte låsa upp din fil, ens om vi ville.",
    ],
    direct:
      "Eftersom de två webbläsarna ansluter direkt till varandra kan båda se den andras nätverksadress (IP-adress), precis som i ett videosamtal.",
    linkWarning:
      "Alla som har länken kan öppna filen. Skicka varje länk bara till den som den är avsedd för.",
    serverHeading: "Vad vår server vet",
    neverHeading: "Aldrig",
    never: [
      ["Din fil", "Varken innehållet, filnamnet, storleken eller filtypen."],
      ["Nyckeln", "Den del av länken som låser upp filen når aldrig oss."],
      ["Namn", "Varken namnet du skriver för dig själv eller namnen på dem du skickar till."],
    ],
    seesHeading: "Bara det den behöver för att koppla ihop er",
    sees: [
      [
        "Din IP-adress och uppgifter om din webbläsare",
        "Som på alla webbplatser du besöker. Vi använder dem bara för att visa dig sidan och koppla ihop er, och skriver aldrig in dem i våra loggar.",
      ],
      [
        "Ett länk-ID",
        "Varje länk har ett slumpmässigt ID, som ett nummer på en kölapp, så att rätt två webbläsare kan hitta varandra. Det kan inte låsa upp något. Vi glömmer det inom en minut efter att avsändarens sida har stängts, förutom de första tecknen i våra loggrader.",
      ],
      [
        "Uppkopplingsmeddelanden",
        "Några små, låsta meddelanden som hjälper de två webbläsarna att ansluta. Vi skickar dem vidare utan att kunna läsa dem, och sparar dem inte.",
      ],
    ],
    logLines: "Loggrader",
    keepHeading: "Vad vi sparar",
    keep: "Vi har inga konton, ingen databas, inga cookies och ingen spårning. Förutom loggraderna ovan sparas ingenting när avsändarens sida har stängts, inom högst en minut.",
  },
};
