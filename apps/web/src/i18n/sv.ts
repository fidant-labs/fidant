// Swedish text. Same keys as en.ts.

import type { LogFields } from "@sigill/protocol";
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
  server: {
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
