#pragma once

#include <stdbool.h>
#include <stdint.h>

#define MAPPER_MAX_LEDS 10000
#define MAPPER_CODE_WORDS 12
#define MAPPER_FRAME_SYMBOLS 28

bool mapper_encode(uint16_t index, uint16_t count, uint8_t words[MAPPER_CODE_WORDS]);
uint8_t mapper_frame_symbol(const uint8_t words[MAPPER_CODE_WORDS], unsigned int position);
