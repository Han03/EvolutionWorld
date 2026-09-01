# 简单 Makefile（无需 cmake 亦可构建）
CXX ?= g++
CXXFLAGS ?= -std=c++17 -O2 -Wall -Wextra -Wno-unused-parameter
LDFLAGS ?= -lcrypto -lpthread

# 可选 MySQL 后端：检测到 mysql.h 则启用（EW_HAVE_MYSQL）并链接 libmysqlclient
HAVE_MYSQL := $(shell test -f /usr/include/mysql/mysql.h && echo 1)
ifeq ($(HAVE_MYSQL),1)
  CXXFLAGS += -DEW_HAVE_MYSQL=1
  MYSQL_LIBS := $(shell mysql_config --libs 2>/dev/null)
  LDFLAGS += $(MYSQL_LIBS)
endif

SRCS := $(wildcard src/*.cpp src/util/*.cpp src/game/*.cpp src/auth/*.cpp src/anticheat/*.cpp src/net/*.cpp src/store/*.cpp)
OBJS := $(SRCS:.cpp=.o)
TARGET := evolution_server

all: $(TARGET)

$(TARGET): $(OBJS)
	$(CXX) $(CXXFLAGS) -o $@ $(OBJS) $(LDFLAGS)

%.o: %.cpp
	$(CXX) $(CXXFLAGS) -Isrc -c $< -o $@

clean:
	rm -f $(OBJS) $(TARGET)

.PHONY: all clean
